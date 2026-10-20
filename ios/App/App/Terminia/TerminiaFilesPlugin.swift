import Capacitor
import Foundation
import UIKit
import UniformTypeIdentifiers

private struct FolderBookmark: Codable {
    var id: String
    var name: String
    var bookmark: Data
    var addedAt: Date
    var lastPath: String
}

/// File access for Terminia: Apple's document picker (open a folder in place,
/// import files, copy a folder in, export / Save to Files), persisted folder
/// bookmarks, coordinated file operations inside the workspace, the cache and
/// user-selected folders, and native zip / SHA-256 for large artifacts.
/// Contract: src/platform/plugins.ts (TerminiaFilesPlugin).
@objc(TerminiaFilesPlugin)
public class TerminiaFilesPlugin: CAPPlugin, CAPBridgedPlugin, UIDocumentPickerDelegate {
    public let identifier = "TerminiaFilesPlugin"
    public let jsName = "TerminiaFiles"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getWorkspace", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pickFolder", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "listFolders", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openFolder", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "closeFolder", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "forgetFolder", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "importFiles", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "importFolder", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "exportFile", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "list", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stat", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "readText", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "writeText", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "readBase64", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "writeBase64", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "mkdir", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "remove", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "rename", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "copy", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "transfer", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "zipEntries", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "zipExtract", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "sha256", returnType: CAPPluginReturnPromise),
    ]

    private enum PickerPurpose {
        case folder(CAPPluginCall)
        case importFiles(CAPPluginCall, destination: URL, root: URL)
        case importFolder(CAPPluginCall, destination: URL, root: URL)
        case export(CAPPluginCall)
    }

    private var pickerPurpose: PickerPurpose?
    private let bookmarksLock = NSLock()
    private let maxTextBytes = 20 * 1024 * 1024
    private let work = DispatchQueue(label: "com.terminia.files", qos: .userInitiated, attributes: .concurrent)

    public override func load() {
        try? TerminiaPaths.prepare()
    }

    // MARK: - Workspace and folders

    @objc func getWorkspace(_ call: CAPPluginCall) {
        do {
            try TerminiaPaths.prepare()
            call.resolve(["path": TerminiaPaths.workspaceRoot.path])
        } catch {
            call.reject("Could not prepare the workspace: \(error.localizedDescription)", "IO_ERROR")
        }
    }

    @objc func pickFolder(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.folder], asCopy: false)
            picker.allowsMultipleSelection = false
            self.present(picker, purpose: .folder(call))
        }
    }

    @objc func listFolders(_ call: CAPPluginCall) {
        let folders = loadBookmarks().map { entry -> [String: Any] in
            var stale = false
            var available = false
            var path = entry.lastPath
            if let url = try? URL(resolvingBookmarkData: entry.bookmark, options: [], relativeTo: nil, bookmarkDataIsStale: &stale) {
                available = true
                path = url.path
            }
            return [
                "id": entry.id, "name": entry.name, "path": path, "available": available, "stale": stale,
                "open": TerminiaAccessRegistry.shared.url(for: entry.id) != nil,
                "addedAt": entry.addedAt.timeIntervalSince1970 * 1000,
            ]
        }
        call.resolve(["folders": folders])
    }

    @objc func openFolder(_ call: CAPPluginCall) {
        guard let id = call.getString("id"), var entry = loadBookmarks().first(where: { $0.id == id }) else {
            call.reject("Unknown folder.", "NOT_FOUND")
            return
        }
        if let url = TerminiaAccessRegistry.shared.url(for: id) {
            call.resolve(["id": id, "name": entry.name, "path": url.path, "stale": false])
            return
        }
        var stale = false
        guard let url = try? URL(resolvingBookmarkData: entry.bookmark, options: [], relativeTo: nil, bookmarkDataIsStale: &stale) else {
            call.reject("The folder '\(entry.name)' is no longer available. It may have been moved or deleted, or its storage provider is signed out. Choose it again.", "UNAVAILABLE")
            return
        }
        guard url.startAccessingSecurityScopedResource() else {
            call.reject("iOS did not grant access to '\(entry.name)'. Choose the folder again.", "PERMISSION_DENIED")
            return
        }
        if stale, let fresh = try? url.bookmarkData(options: [], includingResourceValuesForKeys: nil, relativeTo: nil) {
            entry.bookmark = fresh
        }
        entry.lastPath = url.path
        updateBookmark(entry)
        TerminiaAccessRegistry.shared.activate(id: id, url: url)
        call.resolve(["id": id, "name": entry.name, "path": url.path, "stale": stale])
    }

    @objc func closeFolder(_ call: CAPPluginCall) {
        guard let id = call.getString("id") else {
            call.reject("'id' is required.", "INVALID_ARGUMENT")
            return
        }
        TerminiaAccessRegistry.shared.deactivate(id: id)?.stopAccessingSecurityScopedResource()
        call.resolve()
    }

    @objc func forgetFolder(_ call: CAPPluginCall) {
        guard let id = call.getString("id") else {
            call.reject("'id' is required.", "INVALID_ARGUMENT")
            return
        }
        TerminiaAccessRegistry.shared.deactivate(id: id)?.stopAccessingSecurityScopedResource()
        saveBookmarks(loadBookmarks().filter { $0.id != id })
        call.resolve()
    }

    // MARK: - Import / export

    @objc func importFiles(_ call: CAPPluginCall) {
        guard let root = call.getString("root"), let base = TerminiaPaths.rootURL(root),
              let destination = TerminiaPaths.resolve(root: root, path: call.getString("destination") ?? "") else {
            call.reject("Invalid destination folder.", "INVALID_PATH")
            return
        }
        let zipOnly = call.getString("kind") == "zip"
        let multiple = call.getBool("multiple", true)
        DispatchQueue.main.async {
            let types: [UTType] = zipOnly ? [.zip] : [.item]
            let picker = UIDocumentPickerViewController(forOpeningContentTypes: types, asCopy: true)
            picker.allowsMultipleSelection = multiple
            self.present(picker, purpose: .importFiles(call, destination: destination, root: base))
        }
    }

    @objc func importFolder(_ call: CAPPluginCall) {
        guard let root = call.getString("root"), let base = TerminiaPaths.rootURL(root),
              let destination = TerminiaPaths.resolve(root: root, path: call.getString("destination") ?? "") else {
            call.reject("Invalid destination folder.", "INVALID_PATH")
            return
        }
        DispatchQueue.main.async {
            let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.folder], asCopy: false)
            picker.allowsMultipleSelection = false
            self.present(picker, purpose: .importFolder(call, destination: destination, root: base))
        }
    }

    @objc func exportFile(_ call: CAPPluginCall) {
        guard let root = call.getString("root"), let path = call.getString("path"),
              let url = TerminiaPaths.resolve(root: root, path: path) else {
            call.reject("Invalid file.", "INVALID_PATH")
            return
        }
        guard FileManager.default.fileExists(atPath: url.path) else {
            call.reject("The file does not exist.", "NOT_FOUND")
            return
        }
        DispatchQueue.main.async {
            let picker = UIDocumentPickerViewController(forExporting: [url], asCopy: true)
            self.present(picker, purpose: .export(call))
        }
    }

    private func present(_ picker: UIDocumentPickerViewController, purpose: PickerPurpose) {
        if let previous = pickerPurpose {
            pickerCall(previous).reject("Another document picker was opened.", "CANCELLED")
        }
        pickerPurpose = purpose
        picker.delegate = self
        guard let presenter = bridge?.viewController else {
            pickerPurpose = nil
            pickerCall(purpose).reject("No view controller is available to present the document picker.", "UNAVAILABLE")
            return
        }
        presenter.present(picker, animated: true)
    }

    private func pickerCall(_ purpose: PickerPurpose) -> CAPPluginCall {
        switch purpose {
        case .folder(let call), .export(let call), .importFiles(let call, _, _), .importFolder(let call, _, _):
            return call
        }
    }

    public func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        guard let purpose = pickerPurpose else { return }
        pickerPurpose = nil
        switch purpose {
        case .folder(let call), .importFolder(let call, _, _): call.resolve(["cancelled": true])
        case .importFiles(let call, _, _): call.resolve(["cancelled": true, "imported": [], "failed": []])
        case .export(let call): call.resolve(["cancelled": true, "exported": false])
        }
    }

    public func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        guard let purpose = pickerPurpose else { return }
        pickerPurpose = nil
        switch purpose {
        case .folder(let call):
            guard let url = urls.first else {
                call.resolve(["cancelled": true])
                return
            }
            addFolder(url, call: call)
        case .importFiles(let call, let destination, let root):
            importPicked(urls, into: destination, root: root, call: call)
        case .importFolder(let call, let destination, let root):
            guard let url = urls.first else {
                call.resolve(["cancelled": true])
                return
            }
            copyFolderIn(url, into: destination, root: root, call: call)
        case .export(let call):
            call.resolve(["cancelled": false, "exported": true])
        }
    }

    private func addFolder(_ url: URL, call: CAPPluginCall) {
        let accessing = url.startAccessingSecurityScopedResource()
        defer { if accessing { url.stopAccessingSecurityScopedResource() } }
        do {
            let data = try url.bookmarkData(options: [], includingResourceValuesForKeys: nil, relativeTo: nil)
            let entry = FolderBookmark(id: UUID().uuidString, name: url.lastPathComponent, bookmark: data, addedAt: Date(), lastPath: url.path)
            var all = loadBookmarks().filter { $0.lastPath != url.path }
            all.append(entry)
            saveBookmarks(all)
            call.resolve(["cancelled": false, "id": entry.id, "name": entry.name, "path": url.path])
        } catch {
            call.reject("Could not remember access to this folder: \(error.localizedDescription)", "IO_ERROR")
        }
    }

    private func importPicked(_ urls: [URL], into destination: URL, root: URL, call: CAPPluginCall) {
        work.async {
            let fm = FileManager.default
            var imported: [[String: Any]] = []
            var failures: [[String: Any]] = []
            do {
                try fm.createDirectory(at: destination, withIntermediateDirectories: true)
            } catch {
                call.reject("Could not create the destination folder: \(error.localizedDescription)", "IO_ERROR")
                return
            }
            for source in urls {
                let accessing = source.startAccessingSecurityScopedResource()
                defer { if accessing { source.stopAccessingSecurityScopedResource() } }
                let target = self.uniqueURL(for: source.lastPathComponent, in: destination)
                do {
                    try fm.copyItem(at: source, to: target)
                    let size = (try? fm.attributesOfItem(atPath: target.path)[.size] as? NSNumber)?.intValue ?? 0
                    imported.append(["name": target.lastPathComponent, "path": self.relativePath(of: target, root: root), "size": size])
                } catch {
                    failures.append(["name": source.lastPathComponent, "error": error.localizedDescription])
                }
            }
            call.resolve(["cancelled": false, "imported": imported, "failed": failures])
        }
    }

    private func copyFolderIn(_ source: URL, into destination: URL, root: URL, call: CAPPluginCall) {
        work.async {
            let accessing = source.startAccessingSecurityScopedResource()
            defer { if accessing { source.stopAccessingSecurityScopedResource() } }
            let fm = FileManager.default
            do {
                try fm.createDirectory(at: destination, withIntermediateDirectories: true)
                let target = self.uniqueURL(for: source.lastPathComponent, in: destination)
                var coordinationError: NSError?
                var copyError: Error?
                NSFileCoordinator().coordinate(readingItemAt: source, options: [], error: &coordinationError) { readURL in
                    do { try fm.copyItem(at: readURL, to: target) } catch { copyError = error }
                }
                if let error = coordinationError ?? (copyError as NSError?) { throw error }
                var files = 0
                if let enumerator = fm.enumerator(at: target, includingPropertiesForKeys: [.isRegularFileKey]) {
                    for case let url as URL in enumerator where (try? url.resourceValues(forKeys: [.isRegularFileKey]))?.isRegularFile == true {
                        files += 1
                    }
                }
                call.resolve(["cancelled": false, "name": target.lastPathComponent, "path": self.relativePath(of: target, root: root), "files": files])
            } catch {
                call.reject("Could not copy the folder: \(error.localizedDescription)", terminiaErrorCode(error))
            }
        }
    }

    private func uniqueURL(for name: String, in folder: URL) -> URL {
        let fm = FileManager.default
        var candidate = folder.appendingPathComponent(name)
        let base = (name as NSString).deletingPathExtension
        let ext = (name as NSString).pathExtension
        var counter = 2
        while fm.fileExists(atPath: candidate.path) {
            candidate = folder.appendingPathComponent(ext.isEmpty ? "\(base) \(counter)" : "\(base) \(counter).\(ext)")
            counter += 1
        }
        return candidate
    }

    private func relativePath(of url: URL, root: URL) -> String {
        let path = url.standardizedFileURL.resolvingSymlinksInPath().path
        let rootPath = root.standardizedFileURL.resolvingSymlinksInPath().path
        guard path.hasPrefix(rootPath) else { return url.lastPathComponent }
        return String(path.dropFirst(rootPath.count)).trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    }

    // MARK: - File operations

    @objc func list(_ call: CAPPluginCall) {
        withURL(call) { url in
            let keys: [URLResourceKey] = [.isDirectoryKey, .fileSizeKey, .contentModificationDateKey, .ubiquitousItemDownloadingStatusKey]
            let items = try FileManager.default.contentsOfDirectory(at: url, includingPropertiesForKeys: keys, options: [])
            let entries = items.compactMap { item -> [String: Any]? in
                if item.lastPathComponent == ".DS_Store" || item.lastPathComponent == ".Trash" { return nil }
                let values = try? item.resourceValues(forKeys: Set(keys))
                var entry: [String: Any] = [
                    "name": item.lastPathComponent,
                    "type": (values?.isDirectory ?? false) ? "directory" : "file",
                    "size": values?.fileSize ?? 0,
                    "mtime": (values?.contentModificationDate?.timeIntervalSince1970 ?? 0) * 1000,
                ]
                if let status = values?.ubiquitousItemDownloadingStatus { entry["downloaded"] = status == .current }
                return entry
            }
            call.resolve(["entries": entries])
        }
    }

    @objc func stat(_ call: CAPPluginCall) {
        withURL(call) { url in
            let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
            let type = (attributes[.type] as? FileAttributeType) == .typeDirectory ? "directory" : "file"
            call.resolve([
                "type": type,
                "size": (attributes[.size] as? NSNumber)?.intValue ?? 0,
                "mtime": ((attributes[.modificationDate] as? Date)?.timeIntervalSince1970 ?? 0) * 1000,
            ])
        }
    }

    private func coordinatedRead(_ url: URL, maxBytes: Int) throws -> (Data, Double) {
        if let values = try? url.resourceValues(forKeys: [.ubiquitousItemDownloadingStatusKey]),
           let status = values.ubiquitousItemDownloadingStatus, status != .current {
            try? FileManager.default.startDownloadingUbiquitousItem(at: url)
            throw TerminiaFileError.code("NOT_DOWNLOADED", "'\(url.lastPathComponent)' is still downloading from iCloud. Try again in a moment.")
        }
        var coordinationError: NSError?
        var result: Result<(Data, Double), Error> = .failure(CocoaError(.fileReadUnknown))
        NSFileCoordinator().coordinate(readingItemAt: url, options: [], error: &coordinationError) { readURL in
            do {
                let attributes = try FileManager.default.attributesOfItem(atPath: readURL.path)
                if (attributes[.type] as? FileAttributeType) == .typeDirectory {
                    throw TerminiaFileError.code("IS_A_DIRECTORY", "'\(readURL.lastPathComponent)' is a folder.")
                }
                let size = (attributes[.size] as? NSNumber)?.intValue ?? 0
                if size > maxBytes {
                    throw TerminiaFileError.code("TOO_LARGE", "'\(readURL.lastPathComponent)' is larger than \(maxBytes / 1024 / 1024) MB.")
                }
                let data = try Data(contentsOf: readURL)
                result = .success((data, ((attributes[.modificationDate] as? Date)?.timeIntervalSince1970 ?? 0) * 1000))
            } catch {
                result = .failure(error)
            }
        }
        if let coordinationError = coordinationError { throw coordinationError }
        return try result.get()
    }

    private func coordinatedWrite(_ url: URL, data: Data, call: CAPPluginCall) throws -> Double {
        let fm = FileManager.default
        if fm.fileExists(atPath: url.path) {
            if !call.getBool("overwrite", true) {
                throw TerminiaFileError.code("EXISTS", "'\(url.lastPathComponent)' already exists.")
            }
            if let expected = call.getDouble("expectedMtime"),
               let current = (try? fm.attributesOfItem(atPath: url.path))?[.modificationDate] as? Date,
               abs(current.timeIntervalSince1970 * 1000 - expected) > 1 {
                throw TerminiaFileError.code("CONFLICT", "'\(url.lastPathComponent)' was changed by another app since it was opened.")
            }
        }
        try fm.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        var coordinationError: NSError?
        var writeError: Error?
        NSFileCoordinator().coordinate(writingItemAt: url, options: [.forReplacing], error: &coordinationError) { writeURL in
            do { try data.write(to: writeURL, options: [.atomic]) } catch { writeError = error }
        }
        if let error = coordinationError ?? (writeError as NSError?) { throw error }
        return (((try? fm.attributesOfItem(atPath: url.path))?[.modificationDate] as? Date)?.timeIntervalSince1970 ?? 0) * 1000
    }

    @objc func readText(_ call: CAPPluginCall) {
        withURL(call) { url in
            let (data, mtime) = try self.coordinatedRead(url, maxBytes: self.maxTextBytes)
            guard let text = String(data: data, encoding: .utf8) else {
                throw TerminiaFileError.code("UNSUPPORTED", "'\(url.lastPathComponent)' is not UTF-8 text.")
            }
            call.resolve(["data": text, "mtime": mtime])
        }
    }

    @objc func readBase64(_ call: CAPPluginCall) {
        let maxBytes = call.getInt("maxBytes") ?? (50 * 1024 * 1024)
        withURL(call) { url in
            let (data, mtime) = try self.coordinatedRead(url, maxBytes: maxBytes)
            call.resolve(["data": data.base64EncodedString(), "size": data.count, "mtime": mtime])
        }
    }

    @objc func writeText(_ call: CAPPluginCall) {
        guard let text = call.getString("data"), let data = text.data(using: .utf8) else {
            call.reject("'data' is required.", "INVALID_ARGUMENT")
            return
        }
        withURL(call) { url in
            let mtime = try self.coordinatedWrite(url, data: data, call: call)
            call.resolve(["mtime": mtime])
        }
    }

    @objc func writeBase64(_ call: CAPPluginCall) {
        guard let encoded = call.getString("data"), let data = Data(base64Encoded: encoded) else {
            call.reject("'data' must be base64.", "INVALID_ARGUMENT")
            return
        }
        withURL(call) { url in
            let mtime = try self.coordinatedWrite(url, data: data, call: call)
            call.resolve(["mtime": mtime])
        }
    }

    @objc func mkdir(_ call: CAPPluginCall) {
        let recursive = call.getBool("recursive", false)
        withURL(call) { url in
            var isDirectory: ObjCBool = false
            if FileManager.default.fileExists(atPath: url.path, isDirectory: &isDirectory) {
                if isDirectory.boolValue && recursive {
                    call.resolve()
                    return
                }
                throw TerminiaFileError.code("EXISTS", "'\(url.lastPathComponent)' already exists.")
            }
            try FileManager.default.createDirectory(at: url, withIntermediateDirectories: recursive)
            call.resolve()
        }
    }

    @objc func remove(_ call: CAPPluginCall) {
        let recursive = call.getBool("recursive", false)
        withURL(call) { url in
            if let root = TerminiaPaths.rootURL(call.getString("root") ?? ""), url.standardizedFileURL == root.standardizedFileURL {
                throw TerminiaFileError.code("PERMISSION_DENIED", "Refusing to delete the root of a storage location.")
            }
            var isDirectory: ObjCBool = false
            guard FileManager.default.fileExists(atPath: url.path, isDirectory: &isDirectory) else {
                throw TerminiaFileError.code("NOT_FOUND", "'\(url.lastPathComponent)' does not exist.")
            }
            if isDirectory.boolValue && !recursive, let children = try? FileManager.default.contentsOfDirectory(atPath: url.path), !children.isEmpty {
                throw TerminiaFileError.code("INVALID_ARGUMENT", "'\(url.lastPathComponent)' is not empty.")
            }
            var coordinationError: NSError?
            var removeError: Error?
            NSFileCoordinator().coordinate(writingItemAt: url, options: [.forDeleting], error: &coordinationError) { target in
                do { try FileManager.default.removeItem(at: target) } catch { removeError = error }
            }
            if let error = coordinationError ?? (removeError as NSError?) { throw error }
            call.resolve()
        }
    }

    @objc func rename(_ call: CAPPluginCall) {
        moveOrCopy(call, copy: false)
    }

    @objc func copy(_ call: CAPPluginCall) {
        moveOrCopy(call, copy: true)
    }

    private func moveOrCopy(_ call: CAPPluginCall, copy: Bool) {
        guard let root = call.getString("root"), let from = call.getString("from"), let to = call.getString("to"),
              let source = TerminiaPaths.resolve(root: root, path: from), let target = TerminiaPaths.resolve(root: root, path: to) else {
            call.reject("Invalid path.", "INVALID_PATH")
            return
        }
        work.async {
            let fm = FileManager.default
            do {
                if fm.fileExists(atPath: target.path) { throw TerminiaFileError.code("EXISTS", "'\(target.lastPathComponent)' already exists.") }
                try fm.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true)
                if copy { try fm.copyItem(at: source, to: target) } else { try fm.moveItem(at: source, to: target) }
                call.resolve()
            } catch {
                call.reject(error.localizedDescription, terminiaErrorCode(error))
            }
        }
    }

    /// Moves or copies a file between storage roots (e.g. a finished download from the cache into the workspace).
    @objc func transfer(_ call: CAPPluginCall) {
        guard let fromRoot = call.getString("fromRoot"), let from = call.getString("from"),
              let toRoot = call.getString("toRoot"), let to = call.getString("to"),
              let source = TerminiaPaths.resolve(root: fromRoot, path: from), let target = TerminiaPaths.resolve(root: toRoot, path: to) else {
            call.reject("Invalid path.", "INVALID_PATH")
            return
        }
        let move = call.getBool("move", false)
        work.async {
            let fm = FileManager.default
            do {
                try fm.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true)
                if fm.fileExists(atPath: target.path) { try fm.removeItem(at: target) }
                if move { try fm.moveItem(at: source, to: target) } else { try fm.copyItem(at: source, to: target) }
                call.resolve()
            } catch {
                call.reject(error.localizedDescription, terminiaErrorCode(error))
            }
        }
    }

    @objc func zipEntries(_ call: CAPPluginCall) {
        withURL(call) { url in
            let entries = try TerminiaZipReader(url: url).entries()
            let list = entries.map { entry -> [String: Any] in
                ["name": entry.name, "size": Int(entry.size), "compressedSize": Int(entry.compressedSize), "method": Int(entry.method)]
            }
            call.resolve(["entries": list])
        }
    }

    @objc func zipExtract(_ call: CAPPluginCall) {
        guard let entryName = call.getString("entry"), let toRoot = call.getString("toRoot"), let to = call.getString("to"),
              let target = TerminiaPaths.resolve(root: toRoot, path: to) else {
            call.reject("Invalid destination.", "INVALID_PATH")
            return
        }
        withURL(call) { url in
            let reader = try TerminiaZipReader(url: url)
            guard let entry = try reader.entries().first(where: { $0.name == entryName }) else {
                throw TerminiaFileError.code("NOT_FOUND", "'\(entryName)' is not in the archive.")
            }
            let size = try reader.extract(entry, to: target)
            call.resolve(["size": Int(size)])
        }
    }

    @objc func sha256(_ call: CAPPluginCall) {
        withURL(call) { url in
            let (hex, size) = try terminiaSHA256(of: url)
            call.resolve(["sha256": hex, "size": Int(size)])
        }
    }

    private func withURL(_ call: CAPPluginCall, _ body: @escaping (URL) throws -> Void) {
        guard let root = call.getString("root") else {
            call.reject("'root' is required.", "INVALID_ARGUMENT")
            return
        }
        guard TerminiaPaths.rootURL(root) != nil else {
            call.reject("The folder is not open. Open it again from Projects.", "ROOT_NOT_OPEN")
            return
        }
        guard let url = TerminiaPaths.resolve(root: root, path: call.getString("path") ?? "") else {
            call.reject("Invalid path.", "INVALID_PATH")
            return
        }
        work.async {
            do {
                try body(url)
            } catch {
                call.reject(error.localizedDescription, terminiaErrorCode(error))
            }
        }
    }

    // MARK: - Bookmark storage

    private func loadBookmarks() -> [FolderBookmark] {
        bookmarksLock.lock(); defer { bookmarksLock.unlock() }
        guard let data = try? Data(contentsOf: TerminiaPaths.bookmarksFile) else { return [] }
        return (try? JSONDecoder().decode([FolderBookmark].self, from: data)) ?? []
    }

    private func saveBookmarks(_ bookmarks: [FolderBookmark]) {
        bookmarksLock.lock(); defer { bookmarksLock.unlock() }
        try? TerminiaPaths.prepare()
        if let data = try? JSONEncoder().encode(bookmarks) {
            try? data.write(to: TerminiaPaths.bookmarksFile, options: [.atomic])
        }
    }

    private func updateBookmark(_ entry: FolderBookmark) {
        var all = loadBookmarks()
        if let index = all.firstIndex(where: { $0.id == entry.id }) {
            all[index] = entry
            saveBookmarks(all)
        }
    }
}
