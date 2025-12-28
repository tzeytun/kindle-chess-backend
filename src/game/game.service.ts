import { Injectable } from '@nestjs/common';
import { Chess } from 'chess.js';
import Redis from 'ioredis';
import { v4 as uuidv4 } from 'uuid';

@Injectable()
export class GameService {
  private redis: Redis;

  private queues: Record<string, string[]> = {
    '5': [],
    '10': [],
    '30': []
  };

  // Taşların Puan Değerleri
  private readonly pieceValues = {
    p: 10,  // Piyon
    n: 30,  // At
    b: 30,  // Fil
    r: 50,  // Kale
    q: 90,  // Vezir
    k: 900  // Şah
  };

  constructor() {
    const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
    console.log(`[SERVICE] Redis Bağlanıyor... URL: ${process.env.REDIS_URL ? 'ENV Var (Render)' : 'Localhost'}`);

    if (process.env.REDIS_URL) {
      this.redis = new Redis(redisUrl);
    } else {
      this.redis = new Redis({ host: 'localhost', port: 6379 });
    }

    // REDIS BAĞLANTI DURUMU LOGLARI
    this.redis.on('connect', () => console.log('[SERVICE] Redis Başarıyla Bağlandı! 🟢'));
    this.redis.on('error', (err) => console.error('[SERVICE] Redis Hatası! 🔴', err));
  }

  // --- RECONNECTION (Yeniden Bağlanma) ---
  async handleConnection(playerId: string): Promise<any> {
    console.log(`[SERVICE] handleConnection: ${playerId} kontrol ediliyor...`);
    const activeGameId = await this.redis.get(`player:${playerId}:game`);

    if (activeGameId) {
      const rawGame = await this.redis.get(`game:${activeGameId}`);
      if (rawGame) {
        const gameState = JSON.parse(rawGame);
        this.calculateCurrentTime(gameState);
        
        console.log(`[SERVICE] ${playerId} eski oyununa döndü: ${activeGameId}`);
        return {
          status: 'reconnected',
          gameId: activeGameId,
          fen: gameState.fen,
          color: gameState.white === playerId ? 'w' : 'b',
          lastMove: gameState.lastMove,
          whiteTime: gameState.whiteTime,
          blackTime: gameState.blackTime
        };
      }
    }
    console.log(`[SERVICE] ${playerId} için aktif oyun yok. Lobiye yönlendiriliyor.`);
    return { status: 'lobby' };
  }

  async removeActiveGame(playerId: string) {
    console.log(`[SERVICE] removeActiveGame: ${playerId} kaydı siliniyor.`);
    await this.redis.del(`player:${playerId}:game`);
  }

  async leaveGame(playerId: string) {
    const activeGameId = await this.redis.get(`player:${playerId}:game`);
    if (activeGameId) {
      console.log(`[SERVICE] leaveGame: ${playerId} oyundan ayrıldı.`);
      await this.redis.del(`player:${playerId}:game`);
      return { success: true };
    }
    return { success: false };
  }

  // --- PES ETME (Resign) ---
  async resignGame(playerId: string): Promise<any> {
    console.log(`[SERVICE] resignGame: ${playerId} pes ediyor.`);
    const activeGameId = await this.redis.get(`player:${playerId}:game`);
    if (!activeGameId) return null;

    const rawGame = await this.redis.get(`game:${activeGameId}`);
    if (!rawGame) return null;

    const gameState = JSON.parse(rawGame);
    const loserColor = gameState.white === playerId ? 'w' : 'b';
    const winnerColor = loserColor === 'w' ? 'b' : 'w';

    return {
      gameId: activeGameId,
      isGameOver: true,
      winner: winnerColor,
      reason: 'resign',
      fen: gameState.fen,
      lastMove: gameState.lastMove,
      whiteTime: gameState.whiteTime,
      blackTime: gameState.blackTime
    };
  }

  // --- OYUN BULMA (Kuyruk) ---
  async joinQueue(playerId: string, timeControl: string): Promise<any> {
    console.log(`[SERVICE] joinQueue: ${playerId}, Süre: ${timeControl}dk`);
    this.removeFromQueues(playerId);

    const queue = this.queues[timeControl];
    if (!queue) return { error: 'Geçersiz zaman modu' };

    if (queue.length > 0) {
      const opponentId = queue.shift();
      if (!opponentId) return { status: 'waiting' };

      if (opponentId === playerId) {
        queue.push(playerId);
        return { status: 'waiting' };
      }

      console.log(`[SERVICE] Eşleşme bulundu! ${playerId} vs ${opponentId}`);
      return await this.createGame(opponentId, playerId, timeControl);
    } else {
      queue.push(playerId);
      console.log(`[SERVICE] ${playerId} kuyruğa eklendi. Bekleniyor...`);
      return { status: 'waiting' };
    }
  }

  // --- ÖZEL ODA ---
  async createPrivateRoom(playerId: string): Promise<string> {
    const roomId = Math.random().toString(36).substring(2, 8).toUpperCase();
    await this.redis.set(`room:${roomId}`, playerId, 'EX', 600);
    console.log(`[SERVICE] Özel oda kuruldu: ${roomId} (Kurucu: ${playerId})`);
    return roomId;
  }

  async joinPrivateRoom(playerId: string, roomId: string): Promise<any> {
    const creatorId = await this.redis.get(`room:${roomId}`);
    if (!creatorId) return { error: 'Oda bulunamadı.' };
    if (creatorId === playerId) return { error: 'Kendi odana giremezsin.' };

    console.log(`[SERVICE] Özel odaya giriş: ${playerId} -> ${roomId}`);
    await this.redis.del(`room:${roomId}`);
    return await this.createGame(creatorId, playerId, '10');
  }

  // --- OYUN OLUŞTURMA ---
  private async createGame(whiteId: string, blackId: string, timeControlStr: string) {
    const gameId = uuidv4();
    console.log(`[SERVICE] OYUN OLUŞTURULDU: ${gameId} (Tip: ${timeControlStr})`);
    
    const fen = new Chess().fen();
    
    // Bot oyunuysa (içinde : varsa) veya süre 0 gelirse varsayılan 10dk ver
    const duration = timeControlStr.includes(':') ? 10 : (parseInt(timeControlStr) || 10);
    const initialTime = duration * 60;

    const gameState = {
      white: whiteId,
      black: blackId,
      fen: fen,
      type: timeControlStr,
      lastMove: null,
      whiteTime: initialTime,
      blackTime: initialTime,
      lastMoveTimestamp: Date.now()
    };

    await this.redis.set(`game:${gameId}`, JSON.stringify(gameState), 'EX', 3600 * 24);
    await this.redis.set(`player:${whiteId}:game`, gameId, 'EX', 3600 * 24);
    
    if (blackId !== 'BOT_PLAYER') {
        await this.redis.set(`player:${blackId}:game`, gameId, 'EX', 3600 * 24);
    }

    return {
      status: 'started',
      gameId,
      whitePlayer: whiteId,
      blackPlayer: blackId,
      fen,
      whiteTime: initialTime,
      blackTime: initialTime
    };
  }

  // --- BOT OYUNU BAŞLATMA ---
  async createBotGame(playerId: string, difficulty: 'easy' | 'medium' | 'hard') {
    const botId = "BOT_PLAYER";
    console.log(`[SERVICE] Bot oyunu isteniyor: ${playerId} vs BOT (${difficulty})`);
    return await this.createGame(playerId, botId, `bot:${difficulty}`);
  }

  // --- HAMLE YAPMA (İNSAN) ---
  async makeMove(gameId: string, playerId: string, move: { from: string, to: string }) {
    const rawGame = await this.redis.get(`game:${gameId}`);
    if (!rawGame) throw new Error('Oyun bulunamadı');

    const gameState = JSON.parse(rawGame);
    this.calculateCurrentTime(gameState);

    // Süre kontrolü
    if (gameState.whiteTime <= 0) return { isGameOver: true, winner: 'b', reason: 'timeout', fen: gameState.fen };
    if (gameState.blackTime <= 0) return { isGameOver: true, winner: 'w', reason: 'timeout', fen: gameState.fen };

    const chess = new Chess(gameState.fen);
    
    // Sıra kontrolü
    const isWhite = gameState.white === playerId;
    if ((isWhite && chess.turn() !== 'w') || (!isWhite && chess.turn() !== 'b')) {
      throw new Error('Sıra sende değil');
    }

    try {
      chess.move(move);
      gameState.fen = chess.fen();
      gameState.lastMove = { from: move.from, to: move.to };
      gameState.lastMoveTimestamp = Date.now();

      await this.redis.set(`game:${gameId}`, JSON.stringify(gameState), 'EX', 3600 * 24);
      console.log(`[SERVICE] Hamle işlendi: ${playerId} -> ${move.from}-${move.to}`);

      return {
        fen: gameState.fen,
        turn: chess.turn(),
        isGameOver: chess.isGameOver(),
        winner: chess.isCheckmate() ? (chess.turn() === 'w' ? 'b' : 'w') : null,
        reason: chess.isCheckmate() ? 'checkmate' : null,
        lastMove: gameState.lastMove,
        whiteTime: gameState.whiteTime,
        blackTime: gameState.blackTime
      };
    } catch (e) {
      console.error(`[SERVICE] Geçersiz hamle denemesi: ${e.message}`);
      throw new Error('Geçersiz hamle');
    }
  }

  // --- AKILLI BOT HAMLESİ ---
  async makeSmartBotMove(gameId: string) {
    const rawGame = await this.redis.get(`game:${gameId}`);
    if (!rawGame) return null;
    
    const gameState = JSON.parse(rawGame);
    const chess = new Chess(gameState.fen);
    
    // Sadece bot sırasıysa ve oyun bitmediyse
    if (gameState.black !== 'BOT_PLAYER' || chess.turn() !== 'b' || chess.isGameOver()) return null;

    const difficulty = gameState.type.split(':')[1] || 'easy';
    console.log(`[SERVICE-BOT] Bot düşünüyor... (Zorluk: ${difficulty})`);

    let chosenMove;

    if (difficulty === 'easy') {
        // KOLAY: Rastgele
        const moves = chess.moves({ verbose: true });
        if (moves.length > 0) chosenMove = moves[Math.floor(Math.random() * moves.length)];
    } else {
        // ORTA: Derinlik 2, ZOR: Derinlik 3
        const depth = difficulty === 'medium' ? 2 : 3;
        chosenMove = this.getBestMove(chess, depth);
    }

    if (!chosenMove) {
        console.log(`[SERVICE-BOT] Bot hamle bulamadı!`);
        return null;
    }

    chess.move(chosenMove);
    gameState.fen = chess.fen();
    gameState.lastMove = { from: chosenMove.from, to: chosenMove.to };
    gameState.lastMoveTimestamp = Date.now();
    
    await this.redis.set(`game:${gameId}`, JSON.stringify(gameState), 'EX', 3600 * 24);
    
    console.log(`[SERVICE-BOT] Bot oynadı: ${chosenMove.from}->${chosenMove.to}`);

    return {
        fen: gameState.fen,
        lastMove: gameState.lastMove,
        isGameOver: chess.isGameOver(),
        winner: chess.isCheckmate() ? 'b' : null,
        reason: chess.isCheckmate() ? 'checkmate' : null,
        whiteTime: gameState.whiteTime,
        blackTime: gameState.blackTime
    };
  }

  // --- MINIMAX ALGORİTMASI ---
  private getBestMove(chess: Chess, depth: number) {
    const moves = chess.moves({ verbose: true });
    
    // DÜZELTME: any tipi ile değişkeni dışarıda tanımlıyoruz
    let bestMove: any = null; 
    let bestValue = -Infinity;

    moves.sort(() => Math.random() - 0.5);

    for (const move of moves) {
        chess.move(move);
        const boardValue = this.minimax(chess, depth - 1, -Infinity, Infinity, false);
        chess.undo(); 

        if (boardValue > bestValue) {
            bestValue = boardValue;
            bestMove = move; // Düzeltme: Dışarıdaki değişkeni güncelliyoruz
        }
    }
    return bestMove || moves[0];
  }

  private minimax(chess: Chess, depth: number, alpha: number, beta: number, isMaximizingPlayer: boolean): number {
    if (depth === 0 || chess.isGameOver()) {
        return this.evaluateBoard(chess);
    }

    const moves = chess.moves({ verbose: true });

    if (isMaximizingPlayer) {
        let maxEval = -Infinity;
        for (const move of moves) {
            chess.move(move);
            const evalNum = this.minimax(chess, depth - 1, alpha, beta, false);
            chess.undo();
            maxEval = Math.max(maxEval, evalNum);
            alpha = Math.max(alpha, evalNum);
            if (beta <= alpha) break;
        }
        return maxEval;
    } else {
        let minEval = Infinity;
        for (const move of moves) {
            chess.move(move);
            const evalNum = this.minimax(chess, depth - 1, alpha, beta, true);
            chess.undo();
            minEval = Math.min(minEval, evalNum);
            beta = Math.min(beta, evalNum);
            if (beta <= alpha) break;
        }
        return minEval;
    }
  }

  // --- TAHTA DEĞERLENDİRME ---
  private evaluateBoard(chess: Chess): number {
    let totalEvaluation = 0;
    const board = chess.board();

    for (let row = 0; row < 8; row++) {
        for (let col = 0; col < 8; col++) {
            const piece = board[row][col];
            if (piece) {
                const value = this.pieceValues[piece.type] || 0;
                // Siyah (Bot) puan toplar, Beyaz puan düşer
                if (piece.color === 'b') {
                    totalEvaluation += value;
                } else {
                    totalEvaluation -= value;
                }
            }
        }
    }
    return totalEvaluation;
  }

  // --- YARDIMCILAR ---
  private calculateCurrentTime(gameState: any) {
    const now = Date.now();
    const elapsedSeconds = (now - gameState.lastMoveTimestamp) / 1000;
    const chess = new Chess(gameState.fen);
    const turn = chess.turn();

    if (turn === 'w') {
      gameState.whiteTime -= elapsedSeconds;
    } else {
      gameState.blackTime -= elapsedSeconds;
    }

    if (gameState.whiteTime < 0) gameState.whiteTime = 0;
    if (gameState.blackTime < 0) gameState.blackTime = 0;
  }

  removeFromQueues(playerId: string) {
    for (const key in this.queues) {
      this.queues[key] = this.queues[key].filter(id => id !== playerId);
    }
  }
}