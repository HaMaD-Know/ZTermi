import Capacitor
import CryptoKit
import Foundation

/// Per-task state; only touched on the session's serial delegate queue (and `cancel`, under the lock).
private final class TaskState {
    let requestId: String
    let call: CAPPluginCall
    let originalOrigin: String
    let pin: String?
    let maxBytes: Int
    let base64: Bool
    let destination: URL?
    var body = Data()
    var failure: (code: String, message: String)?
    var downloaded: (size: Int, sha256: String)?
    var lastProgress = Date.distantPast

    init(requestId: String, call: CAPPluginCall, originalOrigin: String, pin: String?, maxBytes: Int, base64: Bool, destination: URL?) {
        self.requestId = requestId
        self.call = call
        self.originalOrigin = originalOrigin
        self.pin = pin
        self.maxBytes = maxBytes
        self.base64 = base64
        self.destination = destination
    }
}

/// All of Terminia's network traffic on iOS. Credentials are read from the
/// Keychain here and attached only to requests for the origins they are bound
/// to; on a redirect to another origin the Authorization header is dropped.
/// Optional certificate pinning (SHA-256 of the leaf certificate) is enforced
/// for remote agents. Contract: src/platform/plugins.ts (TerminiaHttpPlugin).
@objc(TerminiaHttpPlugin)
public class TerminiaHttpPlugin: CAPPlugin, CAPBridgedPlugin, URLSessionDataDelegate, URLSessionDownloadDelegate {
    public let identifier = "TerminiaHttpPlugin"
    public let jsName = "TerminiaHttp"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "request", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "download", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancel", returnType: CAPPluginReturnPromise),
    ]

    private lazy var session: URLSession = {
        let queue = OperationQueue()
        queue.maxConcurrentOperationCount = 1
        queue.name = "com.terminia.http"
        let configuration = URLSessionConfiguration.default
        configuration.waitsForConnectivity = false
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.urlCache = nil
        return URLSession(configuration: configuration, delegate: self, delegateQueue: queue)
    }()

    private let lock = NSLock()
    private var states: [Int: TaskState] = [:]
    private var tasksByRequest: [String: URLSessionTask] = [:]

    private func register(_ task: URLSessionTask, _ state: TaskState) {
        lock.lock(); defer { lock.unlock() }
        states[task.taskIdentifier] = state
        tasksByRequest[state.requestId] = task
    }

    private func state(for task: URLSessionTask) -> TaskState? {
        lock.lock(); defer { lock.unlock() }
        return states[task.taskIdentifier]
    }

    private func finish(_ task: URLSessionTask) -> TaskState? {
        lock.lock(); defer { lock.unlock() }
        guard let state = states.removeValue(forKey: task.taskIdentifier) else { return nil }
        tasksByRequest.removeValue(forKey: state.requestId)
        return state
    }

    /// Validates the URL and attaches the credential. Returns the pin to enforce, if any.
    private func prepare(_ call: CAPPluginCall, url: URL, request: inout URLRequest) -> (ok: Bool, pin: String?, origin: String) {
        guard TerminiaOrigins.isAllowed(url), let origin = TerminiaOrigins.origin(of: url) else {
            call.reject("Only HTTPS, or HTTP to a local or private-network address, is allowed: \(url.host ?? "")", "INVALID_ARGUMENT")
            return (false, nil, "")
        }
        request.setValue(nil, forHTTPHeaderField: "Authorization")
        var pin: String?
        if let credentialId = call.getString("credentialId") {
            guard let credential = TerminiaKeychain.load(credentialId) else {
                call.reject("No credential is stored for this connection.", "CREDENTIAL_MISSING")
                return (false, nil, origin)
            }
            guard credential.allowedOrigins.contains(origin) else {
                call.reject("This credential is not allowed for \(origin).", "CREDENTIAL_ORIGIN")
                return (false, nil, origin)
            }
            request.setValue("Bearer \(credential.secret)", forHTTPHeaderField: "Authorization")
            pin = credential.pinSha256
        }
        return (true, pin, origin)
    }

    @objc func request(_ call: CAPPluginCall) {
        guard let requestId = call.getString("requestId"), let urlString = call.getString("url"), let url = URL(string: urlString) else {
            call.reject("'requestId' and a valid 'url' are required.", "INVALID_ARGUMENT")
            return
        }
        var request = URLRequest(url: url)
        request.httpMethod = (call.getString("method") ?? "GET").uppercased()
        request.timeoutInterval = Double(call.getInt("timeoutMs") ?? 30_000) / 1000
        for (key, value) in call.getObject("headers") ?? [:] {
            if let value = value as? String, key.lowercased() != "authorization", key.lowercased() != "cookie" {
                request.setValue(value, forHTTPHeaderField: key)
            }
        }
        if let text = call.getString("bodyText") {
            request.httpBody = text.data(using: .utf8)
        } else if let encoded = call.getString("bodyBase64") {
            request.httpBody = Data(base64Encoded: encoded)
        }
        let prepared = prepare(call, url: url, request: &request)
        guard prepared.ok else { return }
        let task = session.dataTask(with: request)
        register(task, TaskState(requestId: requestId, call: call, originalOrigin: prepared.origin, pin: prepared.pin,
                                 maxBytes: call.getInt("maxBytes") ?? 32 * 1024 * 1024, base64: call.getString("responseType") == "base64", destination: nil))
        task.resume()
    }

    @objc func download(_ call: CAPPluginCall) {
        guard let requestId = call.getString("requestId"), let urlString = call.getString("url"), let url = URL(string: urlString),
              let root = call.getString("root"), let path = call.getString("path"),
              let destination = TerminiaPaths.resolve(root: root, path: path) else {
            call.reject("'requestId', a valid 'url' and a destination are required.", "INVALID_ARGUMENT")
            return
        }
        var request = URLRequest(url: url)
        request.timeoutInterval = 120
        for (key, value) in call.getObject("headers") ?? [:] {
            if let value = value as? String, key.lowercased() != "authorization", key.lowercased() != "cookie" {
                request.setValue(value, forHTTPHeaderField: key)
            }
        }
        let prepared = prepare(call, url: url, request: &request)
        guard prepared.ok else { return }
        let task = session.downloadTask(with: request)
        register(task, TaskState(requestId: requestId, call: call, originalOrigin: prepared.origin, pin: prepared.pin,
                                 maxBytes: call.getInt("maxBytes") ?? Int.max, base64: false, destination: destination))
        task.resume()
    }

    @objc func cancel(_ call: CAPPluginCall) {
        guard let requestId = call.getString("requestId") else {
            call.reject("'requestId' is required.", "INVALID_ARGUMENT")
            return
        }
        lock.lock()
        let task = tasksByRequest[requestId]
        lock.unlock()
        task?.cancel()
        call.resolve()
    }

    // MARK: - URLSession delegate

    public func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                           newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        guard let url = request.url, TerminiaOrigins.isAllowed(url) else {
            if let state = state(for: task) { state.failure = ("NETWORK", "Refused a redirect to an insecure location.") }
            completionHandler(nil)
            task.cancel()
            return
        }
        var next = request
        // The token belongs to the original origin only (GitHub redirects artifacts and logs to short-lived storage URLs).
        if TerminiaOrigins.origin(of: url) != state(for: task)?.originalOrigin {
            next.setValue(nil, forHTTPHeaderField: "Authorization")
        }
        completionHandler(next)
    }

    public func urlSession(_ session: URLSession, task: URLSessionTask, didReceive challenge: URLAuthenticationChallenge,
                           completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              let trust = challenge.protectionSpace.serverTrust,
              let state = state(for: task), let pin = state.pin,
              let url = task.currentRequest?.url, TerminiaOrigins.origin(of: url) == state.originalOrigin else {
            completionHandler(.performDefaultHandling, nil)
            return
        }
        // Pinned: accept exactly the certificate whose SHA-256 matches, even if self-signed.
        guard let chain = SecTrustCopyCertificateChain(trust) as? [SecCertificate], let leaf = chain.first else {
            state.failure = ("PIN_MISMATCH", "The server sent no certificate.")
            completionHandler(.cancelAuthenticationChallenge, nil)
            return
        }
        let digest = SHA256.hash(data: SecCertificateCopyData(leaf) as Data).map { String(format: "%02x", $0) }.joined()
        if digest == pin {
            completionHandler(.useCredential, URLCredential(trust: trust))
        } else {
            state.failure = ("PIN_MISMATCH", "The server certificate does not match the pinned fingerprint.")
            completionHandler(.cancelAuthenticationChallenge, nil)
        }
    }

    public func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        guard let state = state(for: dataTask) else { return }
        state.body.append(data)
        if state.body.count > state.maxBytes {
            state.failure = ("TOO_LARGE", "The response is larger than \(state.maxBytes / 1024 / 1024) MB.")
            dataTask.cancel()
        }
    }

    public func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didWriteData bytesWritten: Int64,
                           totalBytesWritten: Int64, totalBytesExpectedToWrite: Int64) {
        guard let state = state(for: downloadTask) else { return }
        if totalBytesWritten > Int64(state.maxBytes) {
            state.failure = ("TOO_LARGE", "The download is larger than the allowed size.")
            downloadTask.cancel()
            return
        }
        let now = Date()
        if now.timeIntervalSince(state.lastProgress) > 0.25 || totalBytesWritten == totalBytesExpectedToWrite {
            state.lastProgress = now
            notifyListeners("downloadProgress", data: [
                "requestId": state.requestId,
                "received": Int(totalBytesWritten),
                "total": totalBytesExpectedToWrite > 0 ? Int(totalBytesExpectedToWrite) : 0,
            ])
        }
    }

    public func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {
        guard let state = state(for: downloadTask), let destination = state.destination else { return }
        let status = (downloadTask.response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else { return }
        // The temporary file disappears when this method returns, so move it now.
        do {
            let fm = FileManager.default
            try fm.createDirectory(at: destination.deletingLastPathComponent(), withIntermediateDirectories: true)
            if fm.fileExists(atPath: destination.path) { try fm.removeItem(at: destination) }
            try fm.moveItem(at: location, to: destination)
            let (hex, size) = try terminiaSHA256(of: destination)
            state.downloaded = (Int(size), hex)
        } catch {
            state.failure = ("IO_ERROR", "Could not save the download: \(error.localizedDescription)")
        }
    }

    public func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard let state = finish(task) else { return }
        if let failure = state.failure {
            state.call.reject(failure.message, failure.code)
            return
        }
        if let error = error as? URLError {
            switch error.code {
            case .cancelled: state.call.reject("Cancelled.", "CANCELLED")
            case .timedOut: state.call.reject("The request timed out.", "TIMEOUT")
            default: state.call.reject(error.localizedDescription, "NETWORK")
            }
            return
        }
        if let error = error {
            state.call.reject(error.localizedDescription, "NETWORK")
            return
        }
        guard let http = task.response as? HTTPURLResponse else {
            state.call.reject("No HTTP response.", "NETWORK")
            return
        }
        var headers: [String: String] = [:]
        for (key, value) in http.allHeaderFields {
            if let key = key as? String { headers[key.lowercased()] = "\(value)" }
        }
        if state.destination != nil {
            let downloaded = state.downloaded
            state.call.resolve([
                "status": http.statusCode,
                "size": downloaded?.size ?? 0,
                "sha256": downloaded?.sha256 ?? "",
                "contentType": headers["content-type"] ?? "",
            ])
            return
        }
        var result: [String: Any] = ["status": http.statusCode, "headers": headers, "url": http.url?.absoluteString ?? ""]
        if state.base64 {
            result["bodyBase64"] = state.body.base64EncodedString()
        } else {
            result["bodyText"] = String(data: state.body, encoding: .utf8) ?? String(decoding: state.body, as: UTF8.self)
        }
        state.call.resolve(result)
    }
}
