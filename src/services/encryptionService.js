const crypto = require('crypto');

// Servico de criptografia para tokens de integracao
// Tokens do Meta Ads, Hotmart e Kiwify sao sensiveis
// Nunca salvamos eles em texto puro no banco

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32; // 256 bits

// Garante que a chave tem exatamente 32 bytes
const getKey = () => {
  const key = process.env.ENCRYPTION_KEY || 'chave-padrao-trocar-em-producao!!';
  return Buffer.from(key.padEnd(KEY_LENGTH, '0').substring(0, KEY_LENGTH));
};

// Criptografar texto (ex: access_token)
const encrypt = (text) => {
  if (!text) return null;
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');
  // Formato: iv:authTag:encrypted
  return `${iv.toString('hex')}:${authTag}:${encrypted}`;
};

// Descriptografar texto
const decrypt = (encryptedText) => {
  if (!encryptedText) return null;
  try {
    const [ivHex, authTagHex, encrypted] = encryptedText.split(':');
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');
    const decipher = crypto.createDecipheriv(ALGORITHM, getKey(), iv);
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (error) {
    console.error('[Encryption] Erro ao descriptografar:', error.message);
    return null;
  }
};

module.exports = { encrypt, decrypt };
