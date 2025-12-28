import {
  WebSocketGateway,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { GameService } from './game.service';

@WebSocketGateway({
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
    credentials: true
  },
  transports: ['websocket', 'polling'],
})
export class GameGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  constructor(private readonly gameService: GameService) {}

  
  async handleConnection(client: Socket) {
    const playerId = client.handshake.query.playerId as string;

    if (!playerId) {
      client.disconnect();
      return;
    }

    client.join(playerId);

    const result = await this.gameService.handleConnection(playerId);

    if (result.status === 'reconnected') {
      client.join(result.gameId);
      client.emit('reconnectGame', result);
    } else {
      client.emit('lobbyStatus', 'Lobiye Hoşgeldin');
    }
  }

  handleDisconnect(client: Socket) {
    const playerId = client.handshake.query.playerId as string;
    if (playerId) this.gameService.removeFromQueues(playerId);
  }

  // 1. KUYRUĞA GİR
  @SubscribeMessage('joinQueue')
  async handleJoinQueue(@ConnectedSocket() client: Socket, @MessageBody() data: { time: string }) {
    const playerId = client.handshake.query.playerId as string;
    const result = await this.gameService.joinQueue(playerId, data.time);

    if (result.status === 'waiting') {
      client.emit('status', `${data.time}dk modu için rakip aranıyor...`);
    } else if (result.status === 'started') {
      this.startGame(result);
    }
  }

  // 2. ÖZEL ODA KUR
  @SubscribeMessage('createRoom')
  async handleCreateRoom(@ConnectedSocket() client: Socket) {
    const playerId = client.handshake.query.playerId as string;
    const roomId = await this.gameService.createPrivateRoom(playerId);
    client.emit('roomCreated', roomId);
    client.emit('status', `Oda Kodu: ${roomId}. Arkadaşını bekle...`);
  }

  // 3. ÖZEL ODAYA GİR
  @SubscribeMessage('joinRoom')
  async handleJoinRoom(@ConnectedSocket() client: Socket, @MessageBody() data: { roomId: string }) {
    const playerId = client.handshake.query.playerId as string;
    const result = await this.gameService.joinPrivateRoom(playerId, data.roomId);

    if (result.error) {
      client.emit('error', result.error);
    } else {
      this.startGame(result);
    }
  }

  // 4. HAMLE
  @SubscribeMessage('makeMove')
  async handleMove(@ConnectedSocket() client: Socket, @MessageBody() data: any) {
    const playerId = client.handshake.query.playerId as string;
    try {
      
      const update = await this.gameService.makeMove(data.gameId, playerId, data.move);
      this.server.to(data.gameId).emit('updateBoard', update);

     
      setTimeout(async () => {
        const botUpdate = await this.gameService.makeSmartBotMove(data.gameId);
        if (botUpdate) {
          this.server.to(data.gameId).emit('updateBoard', botUpdate);
        }
      }, 500); 

    } catch (e) {
      client.emit('error', e.message);
    }
  }

  // 5. BOT İLE OYNA
  @SubscribeMessage('playVsBot')
async handlePlayVsBot(@ConnectedSocket() client: Socket, @MessageBody() data: { difficulty: string }) {
    const playerId = client.handshake.query.playerId as string;
    
    const difficulty = (data && data.difficulty) ? data.difficulty : 'easy';
    
    const result = await this.gameService.createBotGame(playerId, difficulty as any);
    this.startGame(result);
}

  // 6. PES ET
  @SubscribeMessage('resign')
  async handleResign(@ConnectedSocket() client: Socket) {
    const playerId = client.handshake.query.playerId as string;
    const result = await this.gameService.resignGame(playerId);

    if (result) {
      this.server.to(result.gameId).emit('updateBoard', result);
    }
  }

  // 7. MENÜYE DÖN
  @SubscribeMessage('backToMenu')
  async handleBackToMenu(@ConnectedSocket() client: Socket) {
    const playerId = client.handshake.query.playerId as string;
    await this.gameService.removeActiveGame(playerId);
    client.emit('returnedToMenu');
  }

  
  private startGame(data: any) {
    const { gameId, whitePlayer, blackPlayer, fen, whiteTime, blackTime } = data;

    
    this.server.to(whitePlayer).emit('gameStart', {
      gameId,
      color: 'w',
      fen,
      whiteTime,
      blackTime
    });
    
    // Beyazı odaya sok
    this.server.in(whitePlayer).socketsJoin(gameId);

    
    if (blackPlayer !== 'BOT_PLAYER') {
        this.server.to(blackPlayer).emit('gameStart', {
            gameId,
            color: 'b',
            fen,
            whiteTime,
            blackTime
        });
        
        // Siyahı odaya sok
        this.server.in(blackPlayer).socketsJoin(gameId);
    }
  }
}