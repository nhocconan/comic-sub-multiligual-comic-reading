import Foundation
import Security

private let defaultService = "com.tienle.comicsub.broker-token"
private let service = ProcessInfo.processInfo.environment["MANGA_SUB_CREDENTIAL_SERVICE"]
    .flatMap { $0.isEmpty ? nil : $0 } ?? defaultService
private let account = "default"

private func baseQuery() -> [String: Any] {
    [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: service,
        kSecAttrAccount as String: account,
        kSecAttrSynchronizable as String: kCFBooleanFalse as Any,
    ]
}

private func fail(_ message: String, code: Int32) -> Never {
    FileHandle.standardError.write(Data(message.utf8))
    exit(code)
}

private func readCredential() -> Data {
    var query = baseQuery()
    query[kSecReturnData as String] = kCFBooleanTrue
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    if status == errSecItemNotFound {
        fail("not-found", code: 44)
    }
    guard status == errSecSuccess, let data = result as? Data else {
        fail("keychain-read-\(status)", code: 45)
    }
    return data
}

private func writeCredential(_ data: Data) {
    guard !data.isEmpty, data.count <= 4096 else {
        fail("invalid-token", code: 46)
    }
    let query = baseQuery()
    let update: [String: Any] = [kSecValueData as String: data]
    let updateStatus = SecItemUpdate(query as CFDictionary, update as CFDictionary)
    if updateStatus == errSecSuccess {
        return
    }
    guard updateStatus == errSecItemNotFound else {
        fail("keychain-update-\(updateStatus)", code: 47)
    }
    var attributes = query
    attributes[kSecValueData as String] = data
    attributes[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    let addStatus = SecItemAdd(attributes as CFDictionary, nil)
    guard addStatus == errSecSuccess else {
        fail("keychain-add-\(addStatus)", code: 48)
    }
}

private func deleteCredential() {
    let status = SecItemDelete(baseQuery() as CFDictionary)
    guard status == errSecSuccess || status == errSecItemNotFound else {
        fail("keychain-delete-\(status)", code: 49)
    }
}

guard CommandLine.arguments.count == 2 else {
    fail("usage: manga-sub-credentials <read|write|delete|status>", code: 64)
}

switch CommandLine.arguments[1] {
case "read":
    FileHandle.standardOutput.write(readCredential())
case "write":
    writeCredential(FileHandle.standardInput.readDataToEndOfFile())
case "delete":
    deleteCredential()
case "status":
    _ = readCredential()
case let command:
    fail("unknown-command-\(command)", code: 64)
}
