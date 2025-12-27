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
    const result = await this.gameService.handleConnection(client.id);

    if (result.status === 'waiting') {
      client.emit('status', 'Rakip aranıyor...');
    } else {
      const { gameId, whitePlayer, blackPlayer, fen } = result;

      const whiteSocket = this.server.sockets.sockets.get(whitePlayer);
      const blackSocket = this.server.sockets.sockets.get(blackPlayer);

      if (whiteSocket) whiteSocket.join(gameId);
      if (blackSocket) blackSocket.join(gameId);

      if (whiteSocket) whiteSocket.emit('gameStart', { gameId, color: 'w', fen });
      
      // Siyaha: Sen Siyah'sın
      if (blackSocket) blackSocket.emit('gameStart', { gameId, color: 'b', fen });
      
      console.log(`Oyun başladı: ${gameId}`);
    }
}

  handleDisconnect(client: Socket) {
    console.log(`Biri kaçtı: ${client.id}`);
    
  }

  
  @SubscribeMessage('makeMove')
  async handleMove(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { gameId: string; from: string; to: string },
  ) {
    try {
      
      const gameUpdate = await this.gameService.makeMove(data.gameId, {
        from: data.from,
        to: data.to,
      });

     
      this.server.to(data.gameId).emit('updateBoard', gameUpdate);

    } catch (error) {
      
      client.emit('error', error.message);
    }
  }
}