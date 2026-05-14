const Redis = require('ioredis');

// Conexao com o Redis (Upstash)
// rediss:// ja usa TLS automaticamente — nao precisa de tls:{}
const redisUrl = process.env.REDIS_URL || '';
const tlsOptions = redisUrl.startsWith('rediss://') ? { tls: { rejectUnauthorized: false } } : {};

const redis = new Redis(redisUrl, {
  ...tlsOptions,
  maxRetriesPerRequest: 1,
  lazyConnect: true,
  connectTimeout: 8000,
  enableOfflineQueue: false,
});

redis.on('connect', () => {
  console.log('[Redis] Conectado ao Upstash Redis');
});

redis.on('error', (err) => {
  // Nao crasha o servidor se Redis falhar
  console.error('[Redis] Erro de conexao (nao critico):', err.message);
});

// Funcoes helper — todas com try/catch para nao derrubar o servidor

// Salvar com tempo de expiracao (em segundos)
const setEx = async (key, value, ttlSeconds) => {
  try {
    return await redis.setex(key, ttlSeconds, JSON.stringify(value));
  } catch (err) {
    console.error('[Redis] setEx falhou (nao critico):', err.message);
    return null;
  }
};

// Buscar valor
const get = async (key) => {
  try {
    const value = await redis.get(key);
    if (!value) return null;
    try { return JSON.parse(value); } catch { return value; }
  } catch (err) {
    console.error('[Redis] get falhou (nao critico):', err.message);
    return null;
  }
};

// Deletar chave
const del = async (key) => {
  try {
    return await redis.del(key);
  } catch (err) {
    console.error('[Redis] del falhou (nao critico):', err.message);
    return null;
  }
};

// Verificar se chave existe (para throttle de alertas)
const exists = async (key) => {
  try {
    return (await redis.exists(key)) === 1;
  } catch (err) {
    console.error('[Redis] exists falhou (nao critico):', err.message);
    return false;
  }
};

// Incrementar contador
const incr = async (key) => {
  try {
    return await redis.incr(key);
  } catch (err) {
    console.error('[Redis] incr falhou (nao critico):', err.message);
    return null;
  }
};

module.exports = { redis, setEx, get, del, exists, incr };
