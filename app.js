javascript
let songs = [];
let currentIndex = -1;

const audio = document.getElementById("audio");

const songList = document.getElementById("songList");

const playBtn = document.getElementById("play");
const title = document.getElementById("title");
const artist = document.getElementById("artist");
const cover = document.getElementById("cover");


async function loadSongs() {

    try {

        const response =
            await fetch("./data/songs.json");

        if (!response.ok) {
            throw new Error(
                "songs.json lỗi: " +
                response.status
            );
        }

        songs = await response.json();

        console.log(
            "SONGS:",
            songs
        );

        renderSongs();

    } catch (error) {

        console.error(error);

        songList.innerHTML =
            `<div class="empty">
                ❌ ${error.message}
            </div>`;
    }
}


function renderSongs() {

    songList.innerHTML = "";

    songs.forEach(
        (song, index) => {

            const card =
                document.createElement("div");

            card.className = "card";

            card.innerHTML = `

                <img
                    src="${song.cover}"
                >

                <div class="card-title">
                    ${song.title}
                </div>

                <div class="card-artist">
                    ${song.artist}
                </div>

                <div class="card-actions">

                    <button
                        class="play-song"
                    >
                        ▶ Phát
                    </button>

                </div>
            `;


            card
                .querySelector(
                    ".play-song"
                )
                .onclick = () => {

                    playSong(index);

                };


            songList.appendChild(card);

        }
    );
}


function playSong(index) {

    const song =
        songs[index];

    console.log(
        "================================"
    );

    console.log(
        "BÀI:",
        song.title
    );

    console.log(
        "URL:",
        ⁨song.audio⁩
    );


    currentIndex = index;


    title.textContent =
        song.title;

    artist.textContent =
        song.artist;

    cover.src =
        song.cover;


    /*
       QUAN TRỌNG:
       Gán trực tiếp URL MP3
    */

    audio.src =
        ⁨song.audio⁩;


    audio.load();


    console.log(
        "audio.src =",
        audio.src
    );


    /*
       Phát
    */

    const promise =
        ⁨audio.play⁩();


    if (promise !== undefined) {

        promise
            .then(() => {

                console.log(
                    "✅ AUDIO ĐANG PHÁT"
                );

                playBtn.textContent =
                    "⏸";

            })
            .catch(error => {

                console.error(
                    "❌ PLAY ERROR:",
                    error
                );

                alert(
                    "Không phát được audio:\n\n" +
                    error.message
                );

            });

    }

}


/*
   Nút player
*/

playBtn.onclick = () => {

    if (!audio.src) {

        if (songs.length > 0) {

            playSong(0);

        }

        return;
    }


    if (audio.paused) {

        ⁨audio.play⁩();

    } else {

        audio.pause();

    }

};


/*
   Các sự kiện debug
*/

audio.addEventListener(
    "loadstart",
    () => {

        console.log(
            "🔄 loadstart"
        );

    }
);


audio.addEventListener(
    "loadedmetadata",
    () => {

        console.log(
            "✅ metadata loaded"
        );

        console.log(
            "Duration:",
            audio.duration
        );

    }
);


audio.addEventListener(
    "canplay",
    () => {

        console.log(
            "✅ CAN PLAY"
        );

    }
);


audio.addEventListener(
    "playing",
    () => {

        console.log(
            "▶️ PLAYING"
        );

        playBtn.textContent =
            "⏸";

    }
);


audio.addEventListener(
    "pause",
    () => {

        console.log(
            "⏸ PAUSED"
        );

        playBtn.textContent =
            "▶";

    }
);


audio.addEventListener(
    "ended",
    () => {

        console.log(
            "🏁 END"
        );

    }
);


audio.addEventListener(
    "error",
    () => {

        console.error(
            "❌ AUDIO ERROR"
        );

        console.error(
            audio.error
        );

        alert(
            "Audio Error: " +
            (
                audio.error
                    ? audio.error.code
                    : "unknown"
            )
        );

    }
);


loadSongs();
