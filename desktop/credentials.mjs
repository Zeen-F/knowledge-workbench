// Constructing the bridge must not touch the Keychain. On macOS even the
// availability probe can wait for user permission and block the main thread.
export function createCredentials(storage) {
  const requireEncryption = () => {
    if (!storage.isEncryptionAvailable())
      throw new Error("系统加密暂不可用，密钥未保存");
  };
  return {
    encrypt(value) {
      requireEncryption();
      return storage.encryptString(value).toString("base64");
    },
    decrypt(value) {
      requireEncryption();
      return storage.decryptString(Buffer.from(value, "base64"));
    },
  };
}
