import { Server } from "socket.io";
import http from "http";
import "dotenv/config";

import supabase from "./supabase.js";

const server = http.createServer();
const io = new Server(server, {
  cors: {
    origin: [
      "http://localhost:3000",
      "https://kaguya.live",
      "https://www.kaguya.live",
    ],
  },
  path: `/${process.env.BASE_ROUTE}/socket.io`,
});

const PORT = process.env.PORT || 3002;

// 30 minutes ms
const ROOM_DELETE_TIME = 30 * 60 * 1000;

const updateEpisode = async (roomId, episode) => {
  const { data, error } = await supabase
    .from("kaguya_rooms")
    .update({
      episodeId: `${episode.sourceId}-${episode.sourceEpisodeId}`,
    })
    .match({ id: roomId });

  if (error) throw error;

  return data;
};

const updateUserInfo = async (user, info) => {
  const { userId } = user;

  await supabase
    .from("kaguya_room_users")
    .update(info, { returning: "minimal" })
    .match({
      userId,
    });
};

const joinRoom = async ({ roomId, socketId, peerId, user }) => {
  const { userId, name, avatarUrl } = user;

  await supabase.from("kaguya_room_users").upsert(
    {
      roomId,
      id: socketId,
      userId,
      name,
      avatarUrl,
      peerId,
    },
    {
      returning: "minimal",
    }
  );
};

const leaveRoom = async (socketId) => {
  const { data, error } = await supabase
    .from("kaguya_room_users")
    .delete({ returning: "minimal" })
    .match({
      id: socketId,
    });

  if (error) throw error;

  return data;
};

const deleteRoom = async (roomId) => {
  const { data, error } = await supabase
    .from("kaguya_rooms")
    .delete()
    .match({ id: roomId });

  if (error) throw error;

  return data;
};

const getGlobalTime = () => {
  const date = new Date();
  const time = date.getTime() / 1000;

  return time;
};

const rooms = {};

io.on("connection", (socket) => {
  socket.on("join", async (roomId, peerId, user) => {
    if (!rooms[roomId]) {
      rooms[roomId] = {};
    }

    const roomCache = rooms[roomId];

    const roomUser = {
      ...user,
      id: socket.id,
      peerId,
      isMicMuted: true,
      isHeadphoneMuted: false,
      roomId,
      useVoiceChat: false,
    };

    if (roomCache.timeoutId) {
      console.log("cleared timeout");

      clearTimeout(roomCache.timeoutId);
    }

    const roomEmit = (event, ...args) => {
      socket.to(roomId.toString()).emit.apply(socket, [event, ...args]);
    };

    const roomBroadcastEmit = (event, ...args) => {
      socket.broadcast
        .to(roomId.toString())
        .emit.apply(socket, [event, ...args]);
    };

    const eventEmit = (event) => {
      roomEmit("event", event);
    };

    // const invalidate = () => {
    //   console.log("invalidate");
    //   roomEmit("invalidate");
    // };

    await socket.join(roomId.toString());

    await joinRoom({
      roomId,
      socketId: socket.id,
      user: roomUser,
      peerId,
    }).catch(console.error);

    eventEmit({ eventType: "join", user: roomUser });

    console.log(`${user?.name || "Guest"} joined room ${roomId}`);

    socket.on("disconnect", async () => {
      const sockets = await io.in(roomId.toString()).fetchSockets();

      console.log(`${user?.name || "Guest"} left room ${roomId}`);

      await leaveRoom(socket.id).catch(console.error);

      eventEmit({ eventType: "leave", user: roomUser });

      if (!sockets.length) {
        roomCache.timeoutId = setTimeout(() => {
          deleteRoom(roomId).catch(console.error);
        }, ROOM_DELETE_TIME);

        return;
      }
    });

    socket.on("getCurrentTime", () => {
      socket.emit("currentTime", roomCache?.currentPlayerTime || 0);
    });

    socket.on("sendMessage", (message) => {
      roomEmit("message", { body: message, user: roomUser });
    });

    socket.on("sendEvent", (eventType) => {
      eventEmit({ eventType, user: roomUser });
    });

    socket.on("changeEpisode", async (episode) => {
      roomEmit("changeEpisode", episode);

      await updateEpisode(roomId, episode).catch(console.error);
    });

    socket.on("changeVideoState", (videoState) => {
      if (videoState.type === "timeupdate") {
        const { currentTime } = videoState;

        roomCache.currentPlayerTime = currentTime;
      }

      roomBroadcastEmit("videoState", videoState);
    });

    socket.on("getTimeSync-backward", () => {
      const time = getGlobalTime();

      socket.emit("timeSync-backward", time);
    });

    socket.on("getTimeSync-forward", (timeAtClient) => {
      const time = getGlobalTime();

      socket.emit("timeSync-forward", time - timeAtClient);
    });

    socket.on("communicateToggle", (event) => {
      roomEmit("communicateToggle", { event, user: roomUser });
    });

    socket.on("connectVoiceChat", (user) => {
      roomEmit("connectVoiceChat", user);

      updateUserInfo(user, { useVoiceChat: true });
    });

    socket.on("communicateUpdate", (communicate) => {
      updateUserInfo(user, communicate);
    });
  });
});

server.listen(PORT, () => {
  console.log(`listening on *:${PORT}`);
});
