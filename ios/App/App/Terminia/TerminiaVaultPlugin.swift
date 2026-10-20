import Capacitor
import Foundation
import Security
import UIKit

/// A credential as stored in the Keychain. `secret` never leaves native code.
struct TerminiaCredential: Codable {
    var id: String
    var label: String
    var kind: String
    var allowedOrigins: [String]
    var pinSha256: String?
    var createdAt: Double
    var expiresAt: Double?
    var scopes: [String]?
    var secret: String

    var info: [String: Any] {
        var out: [String: Any] = ["id": id, "label": label, "kind": kind, "allowedOrigins": allowedOrigins, "createdAt": createdAt]
        if let pin = pinSha256 { out["pinSha256"] = pin }
        if let expiresAt = expiresAt { out["expiresAt"] = expiresAt }
        if let scopes = scopes { out["scopes"] = scopes }
        return out
    }
}

/// Keychain storage: generic passwords, this device only, available after first unlock.
enum TerminiaKeychain {
    static let service = "com.terminia.vault"

    static func save(_ credential: TerminiaCredential) throws {
        let data = try JSONEncoder().encode(credential)
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: credential.id]
        SecItemDelete(query as CFDictionary)
        var attributes = query
        attributes[kSecValueData as String] = data
        attributes[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(attributes as CFDictionary, nil)
        guard status == errSecSuccess else {
            throw TerminiaFileError.code("INTERNAL", "The Keychain refused to store the credential (status \(status)).")
        }
    }

    static func load(_ id: String) -> TerminiaCredential? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: id,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess, let data = item as? Data else { return nil }
        return try? JSONDecoder().decode(TerminiaCredential.self, from: data)
    }

    static func ids() -> [String] {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecReturnAttributes as String: true,
            kSecMatchLimit as String: kSecMatchLimitAll,
        ]
        var items: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &items) == errSecSuccess, let list = items as? [[String: Any]] else { return [] }
        return list.compactMap { $0[kSecAttrAccount as String] as? String }
    }

    static func delete(_ id: String) {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: id]
        SecItemDelete(query as CFDictionary)
    }
}

/// Origin rules shared by the vault and the HTTP plugin.
enum TerminiaOrigins {
    static func origin(of url: URL) -> String? {
        guard let scheme = url.scheme?.lowercased(), let host = url.host?.lowercased() else { return nil }
        let defaultPort = scheme == "https" ? 443 : 80
        if let port = url.port, port != defaultPort { return "\(scheme)://\(host.contains(":") ? "[\(host)]" : host):\(port)" }
        return "\(scheme)://\(host.contains(":") ? "[\(host)]" : host)"
    }

    /// Loopback, RFC 1918, CGNAT 100.64/10 (Tailscale), link-local and .local names.
    static func isPrivateHost(_ rawHost: String) -> Bool {
        let host = rawHost.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
        if host == "localhost" || host.hasSuffix(".local") || host == "::1" { return true }
        if host.hasPrefix("fe80:") || host.hasPrefix("fc") || host.hasPrefix("fd") { return host.contains(":") }
        let parts = host.split(separator: ".").compactMap { Int($0) }
        guard parts.count == 4, host.split(separator: ".").count == 4 else { return false }
        let (a, b) = (parts[0], parts[1])
        return a == 127 || a == 10 || (a == 192 && b == 168) || (a == 172 && (16...31).contains(b)) || (a == 100 && (64...127).contains(b)) || (a == 169 && b == 254)
    }

    /// HTTPS anywhere; plain HTTP only to local and private-network hosts.
    static func isAllowed(_ url: URL) -> Bool {
        guard let scheme = url.scheme?.lowercased(), let host = url.host else { return false }
        if scheme == "https" { return true }
        return scheme == "http" && isPrivateHost(host)
    }

    static func validate(_ origins: [String]) -> [String]? {
        guard !origins.isEmpty else { return nil }
        var out: [String] = []
        for raw in origins {
            guard let url = URL(string: raw), let origin = origin(of: url), isAllowed(url),
                  url.path.isEmpty || url.path == "/", url.query == nil else { return nil }
            out.append(origin)
        }
        return out
    }
}

private struct DeviceFlow {
    let credentialId: String
    let label: String
    let clientId: String
    let deviceCode: String
    let expiresAt: Date
    var interval: Int
}

/// Credential vault backed by the iOS Keychain, plus GitHub's OAuth device
/// flow, which runs natively so the access token never reaches JavaScript.
/// Contract: src/platform/plugins.ts (TerminiaVaultPlugin).
@objc(TerminiaVaultPlugin)
public class TerminiaVaultPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "TerminiaVaultPlugin"
    public let jsName = "TerminiaVault"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "isAvailable", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "promptSecret", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "list", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "remove", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "githubDeviceStart", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "githubDevicePoll", returnType: CAPPluginReturnPromise),
    ]

    private var flows: [String: DeviceFlow] = [:]
    private let flowsLock = NSLock()

    @objc func isAvailable(_ call: CAPPluginCall) {
        call.resolve(["available": true, "storage": "keychain"])
    }

    @objc func promptSecret(_ call: CAPPluginCall) {
        guard let id = call.getString("id"), !id.isEmpty, id.count <= 120,
              let origins = TerminiaOrigins.validate(call.getArray("allowedOrigins", String.self) ?? []) else {
            call.reject("A credential needs an id and allowed origins (HTTPS, or HTTP on a private network).", "INVALID_ARGUMENT")
            return
        }
        let label = call.getString("label") ?? id
        let requestedKind = call.getString("kind") ?? "generic"
        let pin = call.getString("pinSha256")?.lowercased()
        let message = (call.getString("message") ?? "") + "\n\nOnly sent to: " + origins.joined(separator: ", ")
        DispatchQueue.main.async {
            let alert = UIAlertController(title: call.getString("title") ?? label, message: message, preferredStyle: .alert)
            alert.addTextField { field in
                field.isSecureTextEntry = true
                field.placeholder = call.getString("placeholder")
                field.autocapitalizationType = .none
                field.autocorrectionType = .no
                field.textContentType = .password
            }
            alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in call.resolve(["cancelled": true]) })
            alert.addAction(UIAlertAction(title: "Save", style: .default) { _ in
                let value = alert.textFields?.first?.text?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                guard value.count >= 8 else {
                    call.reject("That does not look like a token.", "INVALID_ARGUMENT")
                    return
                }
                let credential = TerminiaCredential(id: id, label: label, kind: Self.kind(requestedKind, value), allowedOrigins: origins, pinSha256: pin,
                                                    createdAt: Date().timeIntervalSince1970 * 1000, expiresAt: nil, scopes: nil, secret: value)
                do {
                    try TerminiaKeychain.save(credential)
                    call.resolve(["cancelled": false, "credential": credential.info])
                } catch {
                    call.reject(error.localizedDescription, "INTERNAL")
                }
            })
            guard let presenter = self.bridge?.viewController else {
                call.reject("No view controller is available.", "UNAVAILABLE")
                return
            }
            presenter.present(alert, animated: true)
        }
    }

    private static func kind(_ requested: String, _ value: String) -> String {
        guard requested.hasPrefix("github") else { return requested }
        if value.hasPrefix("github_pat_") { return "github-fine-grained" }
        if value.hasPrefix("ghp_") { return "github-classic" }
        if value.hasPrefix("gho_") { return "github-oauth" }
        if value.hasPrefix("ghu_") { return "github-app-user" }
        return requested
    }

    @objc func list(_ call: CAPPluginCall) {
        let credentials = TerminiaKeychain.ids().compactMap { TerminiaKeychain.load($0)?.info }
        call.resolve(["credentials": credentials])
    }

    @objc func remove(_ call: CAPPluginCall) {
        guard let id = call.getString("id") else {
            call.reject("'id' is required.", "INVALID_ARGUMENT")
            return
        }
        TerminiaKeychain.delete(id)
        call.resolve()
    }

    // MARK: - GitHub OAuth device flow

    private func form(_ url: String, _ fields: [String: String]) async throws -> [String: Any] {
        var request = URLRequest(url: URL(string: url)!)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        var allowed = CharacterSet.alphanumerics
        allowed.insert(charactersIn: "-._~")
        request.httpBody = fields
            .map { "\($0.key)=\($0.value.addingPercentEncoding(withAllowedCharacters: allowed) ?? "")" }
            .joined(separator: "&")
            .data(using: .utf8)
        request.timeoutInterval = 30
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw TerminiaFileError.code("NETWORK", "github.com answered \((response as? HTTPURLResponse)?.statusCode ?? 0).")
        }
        guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw TerminiaFileError.code("NETWORK", "github.com sent an unexpected response.")
        }
        return json
    }

    @objc func githubDeviceStart(_ call: CAPPluginCall) {
        guard let id = call.getString("id"), let clientId = call.getString("clientId"), !clientId.isEmpty,
              clientId.range(of: "^[A-Za-z0-9._-]{1,64}$", options: .regularExpression) != nil else {
            call.reject("A valid OAuth client id is required.", "INVALID_ARGUMENT")
            return
        }
        let label = call.getString("label") ?? "GitHub"
        let scopes = (call.getArray("scopes", String.self) ?? []).joined(separator: " ")
        Task {
            do {
                let json = try await form("https://github.com/login/device/code", ["client_id": clientId, "scope": scopes])
                guard let deviceCode = json["device_code"] as? String, let userCode = json["user_code"] as? String,
                      let verification = json["verification_uri"] as? String else {
                    let detail = (json["error_description"] as? String) ?? (json["error"] as? String) ?? "unexpected response"
                    call.reject("GitHub did not start device sign-in: \(detail). Check that device flow is enabled for this app.", "AUTH_FAILED")
                    return
                }
                let expiresIn = (json["expires_in"] as? Int) ?? 900
                let interval = (json["interval"] as? Int) ?? 5
                let flowId = UUID().uuidString
                setFlow(flowId, DeviceFlow(credentialId: id, label: label, clientId: clientId, deviceCode: deviceCode,
                                           expiresAt: Date().addingTimeInterval(TimeInterval(expiresIn)), interval: interval))
                call.resolve(["flowId": flowId, "userCode": userCode, "verificationUri": verification, "expiresIn": expiresIn, "interval": interval])
            } catch {
                call.reject(error.localizedDescription, "NETWORK")
            }
        }
    }

    @objc func githubDevicePoll(_ call: CAPPluginCall) {
        guard let flowId = call.getString("flowId") else {
            call.reject("'flowId' is required.", "INVALID_ARGUMENT")
            return
        }
        guard let flow = getFlow(flowId) else {
            call.resolve(["status": "expired"])
            return
        }
        if Date() > flow.expiresAt {
            dropFlow(flowId)
            call.resolve(["status": "expired"])
            return
        }
        Task {
            do {
                let json = try await form("https://github.com/login/oauth/access_token", [
                    "client_id": flow.clientId,
                    "device_code": flow.deviceCode,
                    "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
                ])
                if let token = json["access_token"] as? String, !token.isEmpty {
                    let scopes = (json["scope"] as? String)?.split(separator: ",").map { String($0).trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
                    var expiresAt: Double?
                    if let seconds = json["expires_in"] as? Int { expiresAt = (Date().timeIntervalSince1970 + Double(seconds)) * 1000 }
                    let credential = TerminiaCredential(id: flow.credentialId, label: flow.label, kind: Self.kind("github-oauth", token),
                                                        allowedOrigins: ["https://api.github.com"], pinSha256: nil,
                                                        createdAt: Date().timeIntervalSince1970 * 1000, expiresAt: expiresAt, scopes: scopes, secret: token)
                    try TerminiaKeychain.save(credential)
                    dropFlow(flowId)
                    call.resolve(["status": "authorized", "credential": credential.info])
                    return
                }
                switch json["error"] as? String {
                case "authorization_pending":
                    call.resolve(["status": "pending"])
                case "slow_down":
                    call.resolve(["status": "slow_down", "interval": (json["interval"] as? Int) ?? flow.interval + 5])
                case "access_denied":
                    dropFlow(flowId)
                    call.resolve(["status": "denied"])
                case "expired_token":
                    dropFlow(flowId)
                    call.resolve(["status": "expired"])
                default:
                    dropFlow(flowId)
                    call.resolve(["status": "error", "error": (json["error_description"] as? String) ?? (json["error"] as? String) ?? "Unknown error"])
                }
            } catch {
                call.resolve(["status": "pending", "error": error.localizedDescription])
            }
        }
    }

    private func setFlow(_ id: String, _ flow: DeviceFlow) {
        flowsLock.lock(); defer { flowsLock.unlock() }
        flows[id] = flow
    }

    private func getFlow(_ id: String) -> DeviceFlow? {
        flowsLock.lock(); defer { flowsLock.unlock() }
        return flows[id]
    }

    private func dropFlow(_ id: String) {
        flowsLock.lock(); defer { flowsLock.unlock() }
        flows.removeValue(forKey: id)
    }
}
