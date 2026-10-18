import CryptoKit
import Foundation
import LocalAuthentication
import Security

/// Native Face ID that the server can check.
///
/// Each person gets a P-256 key in the Secure Enclave that can only be used after Face ID
/// (`.biometryCurrentSet`). To verify, Face ID unlocks the key, the key signs the server's one-time
/// challenge, and the server checks the signature against the public key it registered the first
/// time. The private key never leaves the Secure Enclave, and the face never leaves the phone.
enum FaceIDSigner {
    struct Proof {
        /// SubjectPublicKeyInfo DER, base64.
        let publicKey: String
        /// ECDSA P-256 / SHA-256 signature over the challenge's UTF-8 bytes, DER, base64.
        let signature: String
    }

    enum Failure: LocalizedError {
        case unavailable(String)
        case keychain(OSStatus)

        var errorDescription: String? {
            switch self {
            case .unavailable(let reason): reason
            case .keychain(let status): "Couldn't save your Face ID key (\(status)). Try again."
            }
        }
    }

    private static let service = "com.velroi.sage.device-key"

    /// Asks for Face ID, then signs `challenge` with the key named `keyTag`, creating it the first time.
    static func sign(challenge: String, keyTag: String, reason: String) async throws -> Proof {
        guard SecureEnclave.isAvailable else { throw Failure.unavailable("Face ID needs an iPhone with a Secure Enclave.") }
        let context = LAContext()
        context.localizedCancelTitle = "Not now"
        var policyError: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &policyError) else {
            throw Failure.unavailable(message(for: policyError))
        }
        try await context.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, localizedReason: reason)

        // The evaluated context unlocks the key without a second prompt.
        let data = Data(challenge.utf8)
        do {
            let key = try loadOrCreateKey(tag: keyTag, context: context)
            return try proof(key, data)
        } catch let error as Failure {
            throw error
        } catch {
            // The key no longer works (for example Face ID was re-enrolled): replace it once.
            deleteKey(tag: keyTag)
            return try proof(try loadOrCreateKey(tag: keyTag, context: context), data)
        }
    }

    /// A message a person can act on, for any error from `sign`.
    static func message(for error: Error?) -> String {
        if let failure = error as? Failure { return failure.errorDescription ?? "Face ID didn't work." }
        guard let error = error as? LAError else { return "Face ID didn't work. Try again, or type your name instead." }
        switch error.code {
        case .userCancel, .appCancel, .systemCancel: return "Face ID was cancelled."
        case .biometryNotEnrolled: return "Set up Face ID in Settings first, or type your name instead."
        case .biometryLockout: return "Face ID is locked. Unlock your iPhone with your passcode, then try again."
        case .biometryNotAvailable: return "Face ID isn't available. Check Settings > Face ID & Passcode, or type your name instead."
        case .authenticationFailed: return "Face ID didn't recognize you. Try again."
        default: return "Face ID didn't work. Try again, or type your name instead."
        }
    }

    private static func proof(_ key: SecureEnclave.P256.Signing.PrivateKey, _ data: Data) throws -> Proof {
        let signature = try key.signature(for: data)
        return Proof(publicKey: key.publicKey.derRepresentation.base64EncodedString(), signature: signature.derRepresentation.base64EncodedString())
    }

    private static func loadOrCreateKey(tag: String, context: LAContext) throws -> SecureEnclave.P256.Signing.PrivateKey {
        if let stored = try readKey(tag: tag) {
            return try SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: stored, authenticationContext: context)
        }
        var accessError: Unmanaged<CFError>?
        guard let access = SecAccessControlCreateWithFlags(
            nil, kSecAttrAccessibleWhenUnlockedThisDeviceOnly, [.privateKeyUsage, .biometryCurrentSet], &accessError
        ) else {
            throw accessError.map { $0.takeRetainedValue() as Error } ?? Failure.unavailable("Couldn't protect the key with Face ID.")
        }
        let key = try SecureEnclave.P256.Signing.PrivateKey(accessControl: access, authenticationContext: context)
        try saveKey(key.dataRepresentation, tag: tag)
        return key
    }

    // The keychain holds the Secure Enclave's wrapped key blob, which only this device can use.

    private static func query(tag: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: tag]
    }

    private static func readKey(tag: String) throws -> Data? {
        var query = query(tag: tag)
        query[kSecReturnData as String] = true
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else { throw Failure.keychain(status) }
        return item as? Data
    }

    private static func saveKey(_ data: Data, tag: String) throws {
        deleteKey(tag: tag)
        var item = query(tag: tag)
        item[kSecValueData as String] = data
        item[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        let status = SecItemAdd(item as CFDictionary, nil)
        guard status == errSecSuccess else { throw Failure.keychain(status) }
    }

    private static func deleteKey(tag: String) {
        SecItemDelete(query(tag: tag) as CFDictionary)
    }
}

enum SageConfig {
    /// The mini-app server, from Info.plist (SageBaseURL, set in Config/Base.xcconfig).
    static let baseURL: URL = {
        let value = Bundle.main.object(forInfoDictionaryKey: "SageBaseURL") as? String
        return value.flatMap(URL.init(string:)) ?? URL(string: "https://patient.hackharvard2026.velroi.com")!
    }()
}
