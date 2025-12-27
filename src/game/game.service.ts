import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { Chess } from 'chess.js';
import Redis from 'ioredis';
import { v4 as uuidv4 } from 'uuid'; 

@Injectable()
export class GameService {
  private redis: Redis;
  private waitingPlayerSocketId: string | null = null; 

  constructor() {

    const redisUrl = process.env.REDIS_URL;
    
    if (redisUrl) {
      this.redis = new Redis(redisUrl); 
    } else {
      this.redis = new Redis({ host: 'localhost', port: 6379 });
    }
  }

async handleConnection(socketId: string): Promise<
  | { status: 'waiting' }
  | { status: 'started'; gameId: string; whitePlayer: string; blackPlayer: string; fen: string }
> {
  if (this.waitingPlayerSocketId) {
    const playerWhite = this.waitingPlayerSocketId;
    const playerBlack = socketId;

    if (playerWhite === playerBlack) return { status: 'waiting' };

    const gameId = uuidv4();
    const initialFen = new Chess().fen();

    const gameState = {
      white: playerWhite,
      black: playerBlack,
      fen: initialFen,
      pgn: '',
    };

    await this.redis.set(`game:${gameId}`, JSON.stringify(gameState), 'EX', 3600);
    this.waitingPlayerSocketId = null;

    
    return { 
        status: 'started', 
        gameId, 
        whitePlayer: playerWhite, 
        blackPlayer: playerBlack, 
        fen: initialFen 
    };

  } else {
    this.waitingPlayerSocketId = socketId;
    return { status: 'waiting' };
  }
}

  
  async makeMove(gameId: string, move: { from: string, to: string, promotion?: string }) {
    
    const rawGame = await this.redis.get(`game:${gameId}`);
    if (!rawGame) throw new NotFoundException('Oyun bulunamadı veya süre aşımı.');

    const gameState = JSON.parse(rawGame);
    const chess = new Chess(gameState.fen);

    try {
      
      const moveResult = chess.move(move); 

      
      gameState.fen = chess.fen();
      gameState.pgn = chess.pgn();

      
      await this.redis.set(`game:${gameId}`, JSON.stringify(gameState), 'EX', 3600);

      return {
        fen: gameState.fen,
        turn: chess.turn(),
        isGameOver: chess.isGameOver(),
        winner: chess.isCheckmate() ? (chess.turn() === 'w' ? 'b' : 'w') : null,
        lastMove: moveResult
      };

    } catch (e) {
      throw new BadRequestException('Hatalı hamle');
    }
  }

 
  async getGameByPlayerId(socketId: string) {
    
  }
}