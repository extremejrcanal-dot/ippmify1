// ═══════════════════════════════════════════════════════════════════════════
// src/jobs/syncScheduler.js
// Scheduler automático para sincronizar métricas da Meta API periodicamente.
// Cole este arquivo em src/jobs/syncScheduler.js e chame startSyncScheduler()
// no seu server.js (ver instrução no final deste arquivo).
// ═══════════════════════════════════════════════════════════════════════════

const { query } = require('../db');                   // ajuste o caminho se precisar
const { runFullSync } = require('../services/metaService'); // ajuste o caminho se precisar

// Intervalo entre cada rodada de sync (em ms)
// 30 minutos é o balanço ideal: atualiza sem estourar o rate limit da Meta API
const SYNC_INTERVAL_MS = 30 * 60 * 1000; // 30 minutos

// Evita múltiplas rodadas simultâneas se uma demorar muito
let syncRunning = false;

const syncAllUsers = async () => {
  if (syncRunning) {
    console.log('[Scheduler] Sync já em execução, pulando esta rodada.');
    return;
  }

  syncRunning = true;
  const started = Date.now();
  console.log(`[Scheduler] === Iniciando sync automático em ${new Date().toISOString()} ===`);

  let users;
  try {
    // Busca apenas usuários com pelo menos uma integração ativa
    const result = await query(`
      SELECT DISTINCT u.id, u.email
      FROM users u
      INNER JOIN integrations i ON i.user_id = u.id
      WHERE i.status = 'active'
        AND i.access_token IS NOT NULL
      ORDER BY u.id
    `);
    users = result.rows;
  } catch (err) {
    console.error('[Scheduler] Erro ao buscar usuários:', err.message);
    syncRunning = false;
    return;
  }

  console.log(`[Scheduler] ${users.length} usuário(s) com integrações ativas.`);

  for (const user of users) {
    try {
      console.log(`[Scheduler] Sincronizando usuário ${user.id} (${user.email})...`);
      await runFullSync(user.id);
      console.log(`[Scheduler] ✓ Usuário ${user.id} sincronizado.`);
    } catch (err) {
      // Loga o erro mas continua para o próximo usuário
      console.error(`[Scheduler] ✗ Erro ao sincronizar usuário ${user.id}:`, err.message);
    }
  }

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`[Scheduler] === Sync finalizado em ${elapsed}s ===`);
  syncRunning = false;
};

/**
 * Inicia o scheduler automático de sincronização de métricas.
 * Chame esta função no seu server.js após o servidor estar pronto.
 *
 * Exemplo de uso em server.js:
 *   const { startSyncScheduler } = require('./jobs/syncScheduler');
 *   startSyncScheduler();
 */
const startSyncScheduler = () => {
  console.log(`[Scheduler] Iniciado — sync a cada ${SYNC_INTERVAL_MS / 60000} minutos.`);

  // Roda imediatamente no boot para não esperar o primeiro intervalo
  syncAllUsers().catch(err => console.error('[Scheduler] Erro na sync inicial:', err.message));

  // Continua rodando no intervalo definido
  setInterval(() => {
    syncAllUsers().catch(err => console.error('[Scheduler] Erro no intervalo:', err.message));
  }, SYNC_INTERVAL_MS);
};

module.exports = { startSyncScheduler, syncAllUsers };

// ═══════════════════════════════════════════════════════════════════════════
// INSTRUÇÃO: como ativar no server.js
// ═══════════════════════════════════════════════════════════════════════════
//
// No seu server.js, adicione:
//
//   const { startSyncScheduler } = require('./jobs/syncScheduler');
//
//   app.listen(PORT, () => {
//     console.log(`Server running on port ${PORT}`);
//     startSyncScheduler(); // ← adicione esta linha aqui
//   });
//
// O scheduler roda imediatamente no boot e depois a cada 30 minutos.
// ═══════════════════════════════════════════════════════════════════════════
