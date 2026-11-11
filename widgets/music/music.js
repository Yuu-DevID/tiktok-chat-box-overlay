const MUSIC_VOLUME = 8;

const cardEl = document.getElementById("card");
const titleEl = document.getElementById("title");
const byEl = document.getElementById("by");

let player = null;
let playerReady = false;
// The song the player has actually been told to load. Kept separate from the
// server's nowPlaying so a re-broadcast of unchanged state (any song-state
// message re-sends the whole thing) doesn't restart the current track.
let loadedId = null;
let pendingSong = null;
let ws = null;

// YouTube's IFrame API calls this global once its script finishes loading.
window.onYouTubeIframeAPIReady = () => {
  player = new YT.Player("player", {
    height: "180",
    width: "320",
    playerVars: { autoplay: 1, controls: 0, disablekb: 1, modestbranding: 1, rel: 0 },
    events: {
      onReady: () => {
        playerReady = true;
        player.setVolume(MUSIC_VOLUME);
        if (pendingSong) {
          const song = pendingSong;
          pendingSong = null;
          play(song);
        }
      },
      onStateChange: (event) => {
        if (event.data === YT.PlayerState.ENDED && loadedId) {
          ws.send({ type: "song-ended", id: loadedId });
        }
      },
      // An un-embeddable or region-blocked video that slipped past validation
      // would otherwise sit here as a silent black rectangle for the rest of
      // the stream, so tell the server to move on instead.
      onError: () => {
        if (loadedId) ws.send({ type: "song-error", id: loadedId });
      },
    },
  });
};

const apiScript = document.createElement("script");
apiScript.src = "https://www.youtube.com/iframe_api";
document.head.appendChild(apiScript);

function play(song) {
  loadedId = song.id;
  player.loadVideoById(song.videoId);
}

function stop() {
  loadedId = null;
  if (playerReady) player.stopVideo();
}

function render(state) {
  const song = state.nowPlaying;

  if (!song) {
    stop();
    cardEl.classList.remove("show");
    titleEl.textContent = "Nothing playing";
    byEl.textContent = "";
    return;
  }

  if (song.id !== loadedId) {
    if (playerReady) {
      play(song);
    } else {
      pendingSong = song;
    }
  }

  cardEl.classList.add("show");
  cardEl.classList.toggle("filler", Boolean(song.isFiller));
  titleEl.textContent = song.title;
  // Only the currently playing song is ever shown. The queue is the streamer's
  // view, not the audience's (see CONTEXT.md).
  byEl.textContent = song.isFiller ? song.channel || "" : `requested by ${song.nickname}`;
}

const setWsStatus = attachStatusIndicator();

ws = connectWS((data) => {
  if (data.type !== "song-state") return;
  render(data);
}, setWsStatus);
