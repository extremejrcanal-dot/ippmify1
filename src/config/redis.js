const Redis = require('ioredis');

// Conexao com o Redis (Upstash)
const redis = new Redis(process.env.REDIS_URL, {
  tls: {},               // Upstash exige TLS
  maxRetriesPerRequest: 3,
  lazyConnect: true,
  connectTimeout: 10000,
});

redis.on('connect', () => {
  console.log('[Redis] Conectado ao Upstash Redis');
});

redis.on('error', (err) => {
  console.error('[Redis] Erro de conexao:', err.message);
});

// Funcoes helper

// Salvar com tempo de expiracao (em segundos)
const setEx = async (key, value, ttlSeconds) => {
  return redis.setex(key, ttlSeconds, JSON.stringify(value));
};

// Buscar valor
const get = async (key) => {
  const value = await redis.get(key);
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
};

// Deletar chave
const del = async (key) => {
  return redis.del(key);
};

// Verificar se chave existe (para throttle de alertas)
const exists = async (key) => {
  return (await redis.exists(key)) === 1;
};

// Incrementar contador
const incr = async (key) => {
  return redis.incr(key);
};

module.exports = { redis, setEx, get, del, exists, incr };
