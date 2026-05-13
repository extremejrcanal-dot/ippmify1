const { Pool } = require('pg');

// Conexao com o banco de dados Supabase (PostgreSQL)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // Necessario para Supabase
  max: 10,              // Maximo de conexoes simultaneas
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

// Testa a conexao ao iniciar
pool.on('connect', () => {
  console.log('[DB] Conectado ao banco de dados Supabase');
});

pool.on('error', (err) => {
  console.error('[DB] Erro no banco de dados:', err.message);
});

// Funcao helper para executar queries
const query = async (text, params) => {
  const start = Date.now();
  try {
    const result = await pool.query(text, params);
    const duration = Date.now() - start;
    if (duration > 1000) {
      console.warn(`[DB] Query lenta (${duration}ms):`, text.substring(0, 100));
    }
    return result;
  } catch (error) {
    console.error('[DB] Erro na query:', error.message);
    throw error;
  }
};

// Transacoes
const transaction = async (callback) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

module.exports = { query, transaction, pool };
