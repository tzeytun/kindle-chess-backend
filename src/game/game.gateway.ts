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
    origin: '*', // Kindle ve Vercel için tüm bağlantılara izin ver
    methods: ['GET', 'POST'],
    credentials: true
  },
  transports: ['websocket', 'polling'], // Kindle eski tarayıcı desteği
})
export class GameGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  constructor(private readonly gameService: GameService) {}

  // --- BAĞLANTI (LOG EKLENDİ) ---
  async handleConnection(client: Socket) {
    const playerId = client.handshake.query.playerId as string;
    console.log(`[SOCKET] Bağlantı İsteği: SocketID: ${client.id}, PlayerID: ${playerId || 'YOK'}`);

    if (!playerId) {
      console.log(`[SOCKET] PlayerID eksik, bağlantı reddediliyor.`);
      client.disconnect();
      return;
    }

    client.join(playerId);

    const result = await this.gameService.handleConnection(playerId);

    if (result.status === 'reconnected') {
      console.log(`[SOCKET] ${playerId} eski oyununa (${result.gameId}) geri bağlandı.`);
      client.join(result.gameId);
      client.emit('reconnectGame', result);
    } else {
      console.log(`[SOCKET] ${playerId} Lobiye alındı.`);
      client.emit('lobbyStatus', 'Lobiye Hoşgeldin');
    }
  }

  // --- BAĞLANTI KOPMA (LOG EKLENDİ) ---
  handleDisconnect(client: Socket) {
    const playerId = client.handshake.query.playerId as string;
    console.log(`[SOCKET] Bağlantı Koptu: ${playerId}`);
    if (playerId) this.gameService.removeFromQueues(playerId);
  }

  // 1. KUYRUĞA GİR
  @SubscribeMessage('joinQueue')
  async handleJoinQueue(@ConnectedSocket() client: Socket, @MessageBody() data: { time: string }) {
    const playerId = client.handshake.query.playerId as string;
    console.log(`[SOCKET] ${playerId} kuyruk isteği: ${data.time}dk`);

    const result = await this.gameService.joinQueue(playerId, data.time);

    if (result.status === 'waiting') {
      client.emit('status', `${data.time}dk modu için rakip aranıyor...`);
    } else if (result.status === 'started') {
      console.log(`[SOCKET] Eşleşme bulundu, oyun başlıyor: ${result.gameId}`);
      this.startGame(result);
    }
  }

  // 2. ÖZEL ODA KUR
  @SubscribeMessage('createRoom')
  async handleCreateRoom(@ConnectedSocket() client: Socket) {
    const playerId = client.handshake.query.playerId as string;
    const roomId = await this.gameService.createPrivateRoom(playerId);
    console.log(`[SOCKET] ${playerId} oda kurdu: ${roomId}`);
    
    client.emit('roomCreated', roomId);
    client.emit('status', `Oda Kodu: ${roomId}. Arkadaşını bekle...`);
  }

  // 3. ÖZEL ODAYA GİR
  @SubscribeMessage('joinRoom')
  async handleJoinRoom(@ConnectedSocket() client: Socket, @MessageBody() data: { roomId: string }) {
    const playerId = client.handshake.query.playerId as string;
    console.log(`[SOCKET] ${playerId} odaya girmek istiyor: ${data.roomId}`);
    
    const result = await this.gameService.joinPrivateRoom(playerId, data.roomId);

    if (result.error) {
      client.emit('error', result.error);
    } else {
      this.startGame(result);
    }
  }

  // 4. HAMLE YAPMA
  @SubscribeMessage('makeMove')
  async handleMove(@ConnectedSocket() client: Socket, @MessageBody() data: any) {
    const playerId = client.handshake.query.playerId as string;
    console.log(`[SOCKET] Hamle: ${playerId} -> Game: ${data.gameId}`);
    
    try {
      const update = await this.gameService.makeMove(data.gameId, playerId, data.move);
      this.server.to(data.gameId).emit('updateBoard', update);

      // Bot Hamlesi (Eğer oyun botlaysa service kendi içinde kontrol ediyor)
      setTimeout(async () => {
        const botUpdate = await this.gameService.makeSmartBotMove(data.gameId);
        if (botUpdate) {
          console.log(`[SOCKET] Bot karşı hamle yaptı.`);
          this.server.to(data.gameId).emit('updateBoard', botUpdate);
        }
      }, 500); 

    } catch (e) {
      console.error(`[SOCKET HATA] Hamle Hatası: ${e.message}`);
      client.emit('error', e.message);
    }
  }

  // 5. BOT İLE OYNA
  @SubscribeMessage('playVsBot')
  async handlePlayVsBot(@ConnectedSocket() client: Socket, @MessageBody() data: { difficulty: string }) {
    const playerId = client.handshake.query.playerId as string;
    const difficulty = (data && data.difficulty) ? data.difficulty : 'easy';
    
    console.log(`[SOCKET] ${playerId} BOT ile oynamak istiyor. Zorluk: ${difficulty}`);

    const result = await this.gameService.createBotGame(playerId, difficulty as any);
    this.startGame(result);
  }

  // 6. PES ET
  @SubscribeMessage('resign')
  async handleResign(@ConnectedSocket() client: Socket) {
    const playerId = client.handshake.query.playerId as string;
    console.log(`[SOCKET] ${playerId} pes etti.`);
    
    const result = await this.gameService.resignGame(playerId);
    if (result) {
      this.server.to(result.gameId).emit('updateBoard', result);
    }
  }

  // 7. MENÜYE DÖN
  @SubscribeMessage('backToMenu')
  async handleBackToMenu(@ConnectedSocket() client: Socket) {
    const playerId = client.handshake.query.playerId as string;
    console.log(`[SOCKET] ${playerId} menüye dönüyor.`);
    
    await this.gameService.removeActiveGame(playerId);
    client.emit('returnedToMenu');
  }

  // YARDIMCI: Oyunu Başlatma
  private startGame(data: any) {
    const { gameId, whitePlayer, blackPlayer, fen, whiteTime, blackTime } = data;
    console.log(`[SOCKET] Oyun Başlatılıyor: ${gameId} (W: ${whitePlayer} - B: ${blackPlayer})`);

    // 1. Beyaza Gönder
    this.server.to(whitePlayer).emit('gameStart', {
      gameId,
      color: 'w',
      fen,
      whiteTime,
      blackTime
    });
    
    // Beyazı odaya sok
    this.server.in(whitePlayer).socketsJoin(gameId);

    // 2. Siyaha Gönder (EĞER BOT DEĞİLSE)
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