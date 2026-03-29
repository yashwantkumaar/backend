/*
  IGNITE Party Game — Multiplayer Room Server
  Stack: Node.js + Express + Socket.io
*/

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*", 
    methods: ["GET", "POST"],
  },
  pingTimeout: 30000,
  pingInterval: 10000,
});

const rooms = new Map();

function generateRoomId() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let id = "";
  for (let i = 0; i < 6; i++)
    id += chars[Math.floor(Math.random() * chars.length)];
  return id;
}

function getPublicRoom(room) {
  return {
    ...room,
    players: room.players.map((p) => ({
      name: p.name,
      emoji: p.emoji,
      isHost: p.isHost,
      eliminated: p.eliminated || false,
      offline: p.offline || false,
      stats: p.stats,
      socketId: p.socketId,
    })),
  };
}

function broadcastRoom(roomId) {
  const room = rooms.get(roomId);
  if (room) io.to(roomId).emit("room-update", getPublicRoom(room));
}

io.on("connection", (socket) => {
  console.log(`[+] ${socket.id} connected`);

  socket.on("create-room", ({ playerName, emoji, difficulty, gameMode }) => {
    if (!playerName || playerName.trim().length === 0)
      return socket.emit("error", { message: "Player name is required." });
    
    let roomId;
    do {
      roomId = generateRoomId();
    } while (rooms.has(roomId));

    const room = {
      id: roomId,
      hostSocketId: socket.id,
      pendingJoins: {}, 
      players: [
        {
          socketId: socket.id,
          name: playerName.trim().substring(0, 16),
          emoji: emoji || "😄",
          isHost: true,
          eliminated: false,
          offline: false,
          stats: { truth: 0, dare: 0, skip: 0 },
        },
      ],
      settings: {
        difficulty: difficulty || "medium",
        gameMode: gameMode || "tod",
      },
      gameState: {
        phase: "lobby",
        round: 1,
        currentPlayer: null,
        currentTask: null,
        spinning: false,
      },
      chat: [],
    };
    rooms.set(roomId, room);
    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.playerName = playerName.trim();
    socket.emit("room-created", { roomId, room: getPublicRoom(room) });
  });
  socket.on('spawn-gem', ({ x, y }) => {
        // Find the room this player is in
        const room = Array.from(socket.rooms).find(r => r !== socket.id);
        if (room) {
            // Broadcast the coordinates to everyone in the room
            io.to(room).emit('spawn-gem', { x, y });
        }
    });

    // 2. A player clicks the gem! 
    socket.on('claim-gem', ({ playerName }) => {
        const room = Array.from(socket.rooms).find(r => r !== socket.id);
        if (room) {
            // Tell everyone who won it, so it instantly hides for the losers
            io.to(room).emit('gem-claimed', { playerName });
        }
    });

    // 3. A player uses their gems to skip a question
    socket.on('gem-skip', ({ playerName }) => {
        const room = Array.from(socket.rooms).find(r => r !== socket.id);
        if (room) {
            // Tell the room so everyone's screen updates and moves to the next turn
            io.to(room).emit('gem-skip-used', { playerName });
        }
    });

  socket.on("join-room", ({ roomId, playerName, emoji }) => {
    const id = (roomId || "").toUpperCase().trim();
    const room = rooms.get(id);
    if (!room) return socket.emit("error", { message: "Room not found." });

    const cleanName = playerName.trim().substring(0, 16);
    const existingPlayer = room.players.find(
      (p) => p.name.toLowerCase() === cleanName.toLowerCase(),
    );

    let joinType = "new";

    if (existingPlayer) {
      if (existingPlayer.offline) {
        joinType = "rejoin";
      } else {
        return socket.emit("error", { message: `Name "${cleanName}" is already taken.` });
      }
    } else {
      if (room.players.length >= 8)
        return socket.emit("error", { message: "Room is full! Max 8 players." });
      
      if (room.gameState.phase !== "lobby") {
        joinType = "late";
      }
    }

    if (joinType === "rejoin" || joinType === "late") {
      if (!room.pendingJoins) room.pendingJoins = {};
      room.pendingJoins[socket.id] = { playerName: cleanName, emoji: emoji || "😄", type: joinType };

      socket.emit("waiting-for-approval");
      io.to(room.hostSocketId).emit("join-request", {
        targetSocketId: socket.id,
        playerName: cleanName,
        type: joinType,
      });
      return;
    }

    executeJoin(socket, room, cleanName, emoji || "😄", false);
  });

  socket.on("resolve-join-request", ({ targetSocketId, approved }) => {
    const room = rooms.get(socket.data.roomId);
    if (!room || room.hostSocketId !== socket.id || !room.pendingJoins || !room.pendingJoins[targetSocketId]) return;

    const requestData = room.pendingJoins[targetSocketId];
    delete room.pendingJoins[targetSocketId];

    const targetSocket = io.sockets.sockets.get(targetSocketId);
    if (!targetSocket) return;

    if (approved) {
      executeJoin(targetSocket, room, requestData.playerName, requestData.emoji, requestData.type === "rejoin");
    } else {
      targetSocket.emit("join-denied", { message: "The host declined your request." });
    }
  });

  function executeJoin(targetSocket, room, playerName, emoji, isRejoin) {
    if (isRejoin) {
      const p = room.players.find((x) => x.name === playerName);
      if (p) { p.socketId = targetSocket.id; p.offline = false; }
    } else {
      room.players.push({
        socketId: targetSocket.id,
        name: playerName,
        emoji: emoji,
        isHost: false,
        eliminated: false,
        offline: false,
        stats: { truth: 0, dare: 0, skip: 0 },
      });
    }

    targetSocket.join(room.id);
    targetSocket.data.roomId = room.id;
    targetSocket.data.playerName = playerName;
    
    targetSocket.emit("room-joined", { roomId: room.id, room: getPublicRoom(room) });
    io.to(room.id).emit("player-joined", { playerName, emoji, rejoined: isRejoin });
    broadcastRoom(room.id);
  }

  socket.on("update-settings", ({ difficulty, gameMode }) => {
    const room = rooms.get(socket.data.roomId);
    if (!room || room.hostSocketId !== socket.id) return;
    room.settings.difficulty = difficulty || room.settings.difficulty;
    room.settings.gameMode = gameMode || room.settings.gameMode;
    broadcastRoom(socket.data.roomId);
  });

  socket.on("start-game", () => {
    const room = rooms.get(socket.data.roomId);
    if (!room || room.hostSocketId !== socket.id) return;
    room.gameState.phase = "playing";
    room.gameState.round = 1;
    broadcastRoom(socket.data.roomId);
    io.to(socket.data.roomId).emit("game-started", { settings: room.settings });
  });

  socket.on("spin", () => {
    const room = rooms.get(socket.data.roomId);
    if (!room || room.gameState.phase !== "playing" || room.gameState.spinning) return;

    room.gameState.spinning = true;
    room.gameState.phase = "spinning";

    const activePlayers = room.players.filter((p) => !p.eliminated && !p.offline);
    if (activePlayers.length === 0) {
      room.gameState.spinning = false;
      room.gameState.phase = "playing";
      return;
    }

    const picked = activePlayers[Math.floor(Math.random() * activePlayers.length)];
    room.gameState.currentPlayer = picked.name;
    room.gameState.currentPlayerId = picked.socketId;

    io.to(room.id).emit("spin-started", { targetPlayer: picked.name });

    setTimeout(() => {
      room.gameState.spinning = false;
      room.gameState.phase = "choice";
      broadcastRoom(room.id);
      io.to(room.id).emit("spin-result", {
        player: picked.name,
        round: room.gameState.round,
      });
    }, 2800);
  });

  socket.on("pick-task", ({ type, questionText }) => {
    const room = rooms.get(socket.data.roomId);
    if (!room || room.gameState.phase !== "choice") return;

    room.gameState.currentTask = { type, text: questionText };
    room.gameState.phase = "task";
    broadcastRoom(room.id);
    io.to(room.id).emit("task-assigned", {
      type,
      text: questionText,
      player: room.gameState.currentPlayer,
    });
  });

  socket.on("new-question", ({ type, questionText }) => {
    const room = rooms.get(socket.data.roomId);
    if (!room || room.gameState.phase !== "task") return;

    room.gameState.currentTask = { type, text: questionText };
    broadcastRoom(room.id);
    io.to(room.id).emit("task-assigned", {
      type,
      text: questionText,
      player: room.gameState.currentPlayer,
    });
  });

  socket.on("complete-task", ({ type }) => {
    const room = rooms.get(socket.data.roomId);
    if (!room || room.gameState.phase !== "task") return;

    const player = room.players.find((p) => p.name === room.gameState.currentPlayer);
    if (player) player.stats[type] = (player.stats[type] || 0) + 1;

    room.gameState.round++;
    room.gameState.phase = "playing";
    room.gameState.currentTask = null;
    broadcastRoom(room.id);
    io.to(room.id).emit("task-completed", {
      round: room.gameState.round,
    });
  });

  socket.on("end-game", () => {
    const room = rooms.get(socket.data.roomId);
    if (!room || room.hostSocketId !== socket.id) return;
    room.gameState.phase = "lobby";
    room.gameState.round = 1;
    room.gameState.currentPlayer = null;
    room.players.forEach((p) => {
      p.stats = { truth: 0, dare: 0, skip: 0 };
      p.eliminated = false;
    });
    broadcastRoom(socket.data.roomId);
    io.to(socket.data.roomId).emit("game-ended");
  });

  socket.on("close-room", () => {
    const room = rooms.get(socket.data.roomId);
    if (!room || room.hostSocketId !== socket.id) return;
    io.to(socket.data.roomId).emit("room-closed");
    rooms.delete(socket.data.roomId);
  });

  socket.on("chat-message", ({ message }) => {
    const room = rooms.get(socket.data.roomId);
    if (!room || !message.trim()) return;
    const msg = {
      player: socket.data.playerName,
      message: message.trim().substring(0, 200),
      ts: Date.now(),
    };
    room.chat.push(msg);
    if (room.chat.length > 100) room.chat = room.chat.slice(-100);
    io.to(room.id).emit("chat-message", msg);
  });

  socket.on("reaction", ({ emoji }) => {
    if (socket.data.roomId)
      io.to(socket.data.roomId).emit("reaction", {
        player: socket.data.playerName,
        emoji,
      });
  });

  socket.on("kick-player", ({ playerName }) => {
    const room = rooms.get(socket.data.roomId);
    if (!room || room.hostSocketId !== socket.id) return;
    const target = room.players.find((p) => p.name === playerName && !p.isHost);
    if (!target) return;

    const targetSocket = io.sockets.sockets.get(target.socketId);
    if (targetSocket) {
      targetSocket.emit("kicked", { message: "You were removed by the host." });
      targetSocket.leave(room.id);
    }
    room.players = room.players.filter((p) => p.name !== playerName);
    io.to(room.id).emit("player-left", { playerName, kicked: true });
    broadcastRoom(room.id);
  });

  socket.on("disconnect", () => {
    const roomId = socket.data.roomId;
    if (!roomId) return;

    const room = rooms.get(roomId);
    if (!room) return;

    const player = room.players.find((p) => p.socketId === socket.id);
    if (player) {
      player.offline = true;
      io.to(roomId).emit("player-left", { playerName: player.name, offline: true });

      if (player.isHost) {
        player.isHost = false;
        const nextOnline = room.players.find((p) => !p.offline);
        if (nextOnline) {
          nextOnline.isHost = true;
          room.hostSocketId = nextOnline.socketId;
          io.to(roomId).emit("host-changed", { newHost: nextOnline.name });
        }
      }

      const activePlayers = room.players.filter((p) => !p.offline);
      if (activePlayers.length === 0) {
        rooms.delete(roomId);
      } else {
        broadcastRoom(roomId);
      }
    }
  });
});

app.get("/", (req, res) => res.json({ status: "Online 🔥" }));
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`🔥 Server on ${PORT}`));
