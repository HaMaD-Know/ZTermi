import Foundation

/// Locations Terminia uses inside the app sandbox, and safe path resolution.
///
/// * The workspace is the app's Documents folder. Info.plist enables
///   UIFileSharingEnabled / LSSupportsOpeningDocumentsInPlace, so it appears in
///   the Files app as "On My iPad > Terminia".
/// * The cache holds in-progress downloads (purgeable, not backed up).
/// * Application Support holds the folder bookmarks.
enum TerminiaPaths {
    static var workspaceRoot: URL {
        FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
    }

    static var cacheRoot: URL {
        FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Terminia", isDirectory: true)
    }

    static var supportRoot: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Terminia", isDirectory: true)
    }

    static var bookmarksFile: URL {
        supportRoot.appendingPathComponent("folder-bookmarks.json", isDirectory: false)
    }

    static func prepare() throws {
        let fm = FileManager.default
        for url in [workspaceRoot, cacheRoot, supportRoot] {
            try fm.createDirectory(at: url, withIntermediateDirectories: true)
        }
        var cache = cacheRoot
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? cache.setResourceValues(values)
    }

    /// The URL of a storage root: "workspace", "cache" or "ext:<bookmark id>" (an open folder).
    static func rootURL(_ root: String) -> URL? {
        switch root {
        case "workspace": return workspaceRoot
        case "cache": return cacheRoot
        default:
            if root.hasPrefix("ext:") {
                return TerminiaAccessRegistry.shared.url(for: String(root.dropFirst(4)))
            }
            return nil
        }
    }

    /// Resolves a root-relative POSIX path, refusing anything that could escape the root.
    static func resolve(root: String, path: String) -> URL? {
        guard let base = rootURL(root) else { return nil }
        if path.hasPrefix("/") || path.contains("\0") || path.contains("\\") || path.count > 4096 { return nil }
        let components = path.split(separator: "/").map(String.init)
        if components.contains("..") { return nil }
        var url = base
        for component in components where component != "." && !component.isEmpty {
            url.appendPathComponent(component)
        }
        return isURL(url, inside: base) ? url : nil
    }

    /// True when `url` is `root` or lies inside it. Both the literal and the
    /// symlink-resolved paths are compared (iOS reports the same container as
    /// /var/... and /private/var/...), and `url` may not exist yet.
    static func isURL(_ url: URL, inside root: URL) -> Bool {
        func contains(_ path: String, _ rootPath: String) -> Bool {
            path == rootPath || path.hasPrefix(rootPath.hasSuffix("/") ? rootPath : rootPath + "/")
        }
        func resolved(_ url: URL) -> String {
            var existing = url.standardizedFileURL
            var tail: [String] = []
            while !FileManager.default.fileExists(atPath: existing.path) && existing.pathComponents.count > 1 {
                tail.insert(existing.lastPathComponent, at: 0)
                existing.deleteLastPathComponent()
            }
            var result = existing.resolvingSymlinksInPath()
            for component in tail {
                result.appendPathComponent(component)
            }
            return result.path
        }
        return contains(url.standardizedFileURL.path, root.standardizedFileURL.path)
            || contains(resolved(url), resolved(root))
    }
}

/// Folders the user granted access to through the document picker and which
/// currently hold an active security-scoped access session.
final class TerminiaAccessRegistry {
    static let shared = TerminiaAccessRegistry()
    private let lock = NSLock()
    private var active: [String: URL] = [:]

    func activate(id: String, url: URL) {
        lock.lock(); defer { lock.unlock() }
        active[id] = url
    }

    func deactivate(id: String) -> URL? {
        lock.lock(); defer { lock.unlock() }
        return active.removeValue(forKey: id)
    }

    func url(for id: String) -> URL? {
        lock.lock(); defer { lock.unlock() }
        return active[id]
    }
}

/// Error codes shared with the TypeScript side (src/fs/native-backend.ts).
enum TerminiaFileError: Error, LocalizedError {
    case code(String, String)

    var errorDescription: String? {
        if case let .code(_, message) = self { return message }
        return nil
    }

    var code: String {
        if case let .code(code, _) = self { return code }
        return "IO_ERROR"
    }
}

/// Maps Foundation errors to the shared error codes.
func terminiaErrorCode(_ error: Error) -> String {
    if let fileError = error as? TerminiaFileError { return fileError.code }
    let nsError = error as NSError
    guard nsError.domain == NSCocoaErrorDomain else { return "IO_ERROR" }
    switch nsError.code {
    case NSFileNoSuchFileError, NSFileReadNoSuchFileError: return "NOT_FOUND"
    case NSFileWriteNoPermissionError, NSFileReadNoPermissionError: return "PERMISSION_DENIED"
    case NSFileWriteOutOfSpaceError: return "NO_SPACE"
    case NSFileWriteFileExistsError: return "EXISTS"
    default: return "IO_ERROR"
    }
}
