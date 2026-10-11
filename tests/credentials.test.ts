import test from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error Desktop modules run directly in Electron.
import { createCredentials } from "../desktop/credentials.mjs";

test("desktop credentials do not probe the Keychain until explicitly requested", () => {
  let probes = 0;
  const credentials = createCredentials({
    isEncryptionAvailable() {
      probes++;
      throw new Error("Keychain requires user permission");
    },
  });
  assert.equal(probes, 0);
  assert.throws(() => credentials.encrypt("synthetic"), /user permission/);
  assert.equal(probes, 1);
});

test("unavailable encryption rejects both operations without a plaintext fallback", () => {
  const credentials = createCredentials({
    isEncryptionAvailable: () => false,
    encryptString: () => assert.fail("must not store a key"),
    decryptString: () => assert.fail("must not decode a key"),
  });
  assert.throws(() => credentials.encrypt("synthetic"), /密钥未保存/);
  assert.throws(() => credentials.decrypt("c3ludGhldGlj"), /密钥未保存/);
});

test("desktop credentials preserve the existing encrypted storage format", () => {
  const ciphertext = Buffer.from([0x76, 0x31, 0x30, 0, 255, 17]);
  const credentials = createCredentials({
    isEncryptionAvailable: () => true,
    encryptString(value: string) {
      assert.equal(value, "synthetic");
      return ciphertext;
    },
    decryptString(value: Buffer) {
      assert.deepEqual(value, ciphertext);
      return "synthetic";
    },
  });
  assert.equal(credentials.encrypt("synthetic"), ciphertext.toString("base64"));
  assert.equal(credentials.decrypt(ciphertext.toString("base64")), "synthetic");
});
