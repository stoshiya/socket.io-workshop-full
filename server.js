var crypto = require('crypto');
var express = require('express');
var app = express();
var http = require('http').Server(app);
var io = require('socket.io')(http);
var port = process.env.PORT || 3000;

app.use(express.static(__dirname + '/public'));

var roomMap = {};
var activeGames = {};
var numUsers = 0;

io.on('connection', function(socket) {

  socket.on('login', function(username) {
    if (socket.user) return;

    username = username.trim();
    if (username.length > 16) return;

    socket.user = {
      id: uid(),
      username: username
    };
    socket.emit('login', socket.user);

    numUsers++;
    io.emit('num users', numUsers);

    joinLobby(socket);
  });

  socket.on('message', function(message) {
    if (!socket.user) return;
    if (!socket.roomId) return;
    if (!message) return;

    var eventName = 'lobby' === socket.roomId ? 'lobby message' : 'message';
    socket.broadcast.to(socket.roomId).emit(eventName, socket.user, message);
  });

  socket.on('add room', function() {
    if (!socket.user) return;

    var room = new Room(socket.user);
    if (roomMap[room.id]) return;

    roomMap[room.id] = room;
    join(socket, room.id);
  });

  socket.on('join room', function(roomId) {
    if (!socket.user) return;

    join(socket, roomId);
  });

  socket.on('leave room', function() {
    if (!socket.user) return;

    joinLobby(socket);
  });

  socket.on('start game', function() {
    if (!socket.user) return;

    var room = roomMap[socket.roomId];
    if (!room) return;

    // check the game starter by owner
    var i = room.sockets.indexOf(socket);
    if (0 !== i) return;

    delete roomMap[room.id];
    io.in(room.id).emit('game started', room);
    socket.broadcast.to('lobby').emit('room removed', room.id);

    // add new active game
    activeGames[room.id] = room;
  });

  socket.on('disconnect', function() {
    leave(socket);

    if (socket.user) {
      delete socket.user;
      numUsers--;
      io.emit('num users', numUsers);
    }
  });
});

var uidToSid = {};
io.of('/game').on('connection', function(socket) {
  socket.on('join', function(userData) {
    socket.user = userData;
    uidToSid[socket.user.id] = socket.id;
  });

  socket.on('player:sync', function(data) {
    socket.broadcast.emit('player:sync', { id: socket.user.id, motion:  data.motion, health: data.health });
  });

  socket.on('player:hit', function(playerID) {
    socket.to(uidToSid[playerID]).emit('player:hit', { damage: 10 });
  });

  socket.on('disconnect', function() {
    delete uidToSid[socket.user.id];
    socket.broadcast.emit('player:disconnected', socket.user.id);
  });
});

http.listen(port, function() {
  console.log('Server listening on port ' + port);
});

function Room(user) {
  this.id = user.id;
  this.name = user.username + '\'s game';
  this.sockets = [];
}

Room.prototype.toJSON = function() {
  return {
    id: this.id,
    name: this.name,
    users: this.sockets.map(function(socket) {
      return socket.user;
    })
  };
};

function uid() {
  return crypto.randomBytes(16).toString('hex');
}

function rooms() {
  return Object.keys(roomMap).map(function(roomId) {
    return roomMap[roomId];
  });
}

function joinLobby(socket) {
  leave(socket);

  socket.join('lobby', function(err) {
    if (err) return;

    socket.roomId = 'lobby';
    socket.emit('join lobby', rooms());
  });
}

function join(socket, roomId) {
  var room = roomMap[roomId];
  if (!room) return;

  leave(socket);

  socket.join(roomId, function(err) {
    if (err) return;

    var room = roomMap[roomId];
    if (!room) return;
    if (!~room.sockets.indexOf(socket)) {
      room.sockets.push(socket);
    }

    socket.roomId = roomId;
    socket.emit('join room', room);
    socket.broadcast.to('lobby').emit('room updated', room);
    socket.broadcast.to(roomId).emit('user joined', socket.user);
  });
}

function leave(socket) {
  var roomId = socket.roomId;
  if (!roomId) return;

  socket.leave(roomId);
  socket.roomId = null;

  if ('lobby' === roomId) {
    socket.emit('leave lobby');
    return;
  }

  var room = roomMap[roomId];
  if (!room) return;

  var i = room.sockets.indexOf(socket);
  if (!~i) return;

  room.sockets.splice(i, 1);
  socket.emit('leave room', room);

  if (i === 0) {
    // remove the room when the user is the creator of it
    delete roomMap[roomId];

    socket.broadcast.to('lobby').emit('room removed', roomId);
    socket.broadcast.to(roomId).emit('room closed');

    // force remaining sockets to join the lobby
    room.sockets.forEach(joinLobby);
  } else {
    socket.broadcast.to('lobby').emit('room changed', room);
    socket.broadcast.to(roomId).emit('user left', socket.user);
  }
}
