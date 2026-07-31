(function() {
    if (window.__musicPlayerDisabled) {
        var player = document.getElementById('musicPlayer');
        if (player) player.style.display = 'none';
        return;
    }

    var player = document.getElementById('musicPlayer');
    var audio = document.getElementById('musicAudio');
    var coverImg = document.getElementById('musicCover');
    var coverPlaceholder = document.getElementById('musicCoverPlaceholder');
    var titleEl = document.getElementById('musicTitle');
    var artistEl = document.getElementById('musicArtist');
    var playBtn = document.getElementById('musicPlay');
    var prevBtn = document.getElementById('musicPrev');
    var nextBtn = document.getElementById('musicNext');
    var iconPlay = playBtn.querySelector('.icon-play');
    var iconPause = playBtn.querySelector('.icon-pause');

    var progressWrap = document.getElementById('musicProgressWrap');
    var progressBar = document.getElementById('musicProgressBar');

    var isPlaying = false;
    var currentSong = null;
    var isLoading = false;
    var _progressRAF = null;

    var cfg = window.__musicPlayerConfig || {};
    var mode = cfg.mode || 'custom';
    var playlists = {
        "default": cfg.playlist || [],
        ameath: cfg.ameathPlaylist || [],
        voice: cfg.voicePlaylist || []
    };
    var activePlaylist = "default";
    var playlist = playlists[activePlaylist];
    var plIdx = -1;

    function updateTextScroll(element) {
        window.requestAnimationFrame(function() {
            var overflow = Math.ceil(element.scrollWidth - element.clientWidth);
            element.classList.toggle('is-scrolling', overflow > 4);
            element.style.setProperty('--music-scroll-distance', '-' + Math.max(0, overflow + 10) + 'px');
        });
    }

    function applySong(song) {
        currentSong = song;
        progressBar.style.width = '0%';

        var coverUrl = song.cover || song.picurl || '';
        if (coverUrl) {
            coverImg.src = coverUrl;
            coverImg.onload = function() {
                coverImg.classList.add('loaded');
                coverPlaceholder.style.display = 'none';
            };
            coverImg.onerror = function() {
                coverImg.classList.remove('loaded');
                coverPlaceholder.style.display = 'flex';
            };
        } else {
            coverImg.classList.remove('loaded');
            coverPlaceholder.style.display = 'flex';
        }

        titleEl.textContent = song.name || '未知歌曲';
        artistEl.textContent = song.artist || song.artistsname || '未知歌手';
        updateTextScroll(titleEl);
        updateTextScroll(artistEl);

        if (song.url) {
            var fullUrl = new URL(song.url, window.location.href).href;
            if (audio.src !== fullUrl) {
                audio.src = song.url;
            }
        } else {
            audio.removeAttribute('src');
        }
    }

    function loadCustomSong(direction) {
        if (!playlist.length) return Promise.resolve(null);
        if (direction === 'next') {
            plIdx = (plIdx + 1) % playlist.length;
        } else if (direction === 'prev') {
            plIdx = (plIdx - 1 + playlist.length) % playlist.length;
        } else {
            plIdx = plIdx < 0 ? 0 : plIdx;
        }
        applySong(playlist[plIdx]);
        return Promise.resolve(null);
    }

    function loadSong(direction) {
        return loadCustomSong(direction);
    }

    function togglePlay() {
        if (!audio.src && currentSong && currentSong.url) {
            audio.src = currentSong.url;
        }
        if (!audio.src) {
            loadSong('next').then(function() {
                if (audio.src) audio.play().catch(function(e) {
                    console.error('播放失败:', e);
                });
            });
            return;
        }
        if (isPlaying) {
            audio.pause();
        } else {
            audio.play().catch(function(e) {
                console.error('播放失败:', e);
            });
        }
    }

    function updatePlayState(playing) {
        isPlaying = playing;
        if (playing) {
            iconPlay.style.display = 'none';
            iconPause.style.display = 'block';
            player.classList.add('playing');
            player.classList.add('show-progress');
        } else {
            iconPlay.style.display = 'block';
            iconPause.style.display = 'none';
            player.classList.remove('playing');
        }
    }

    playBtn.addEventListener('click', togglePlay);

    prevBtn.addEventListener('click', function() {
        var wasPlaying = isPlaying;
        if (isPlaying) { audio.pause(); audio.currentTime = 0; }
        loadSong('prev').then(function() {
            if (wasPlaying && audio.src) audio.play().catch(function() {});
        });
    });

    nextBtn.addEventListener('click', function() {
        var wasPlaying = isPlaying;
        if (isPlaying) { audio.pause(); audio.currentTime = 0; }
        loadSong('next').then(function() {
            if (wasPlaying && audio.src) audio.play().catch(function() {});
        });
    });

    window.addEventListener('homepage:play-track', function(event) {
        var requestedId = event.detail && event.detail.id;
        if (!requestedId || mode !== 'custom') return;
        var requestedIndex = playlist.findIndex(function(song) { return song.id === requestedId; });
        if (requestedIndex < 0) return;

        plIdx = requestedIndex;
        applySong(playlist[plIdx]);
        audio.play().catch(function() {});
    });

    window.addEventListener('homepage:select-playlist', function(event) {
        var detail = event.detail || {};
        var requestedPlaylist = detail.name;
        if (mode !== 'custom' || !playlists[requestedPlaylist] || !playlists[requestedPlaylist].length) return;

        activePlaylist = requestedPlaylist;
        playlist = playlists[activePlaylist];
        plIdx = 0;
        if (isPlaying) audio.pause();
        applySong(playlist[plIdx]);
        window.dispatchEvent(new CustomEvent('homepage:pet-state', {
            detail: { singing: activePlaylist === 'ameath' }
        }));

        if (detail.play) {
            audio.play().catch(function() {});
        }
    });

    audio.addEventListener('play', function() { updatePlayState(true); });
    audio.addEventListener('pause', function() { updatePlayState(false); });

    audio.addEventListener('ended', function() {
        loadSong('next').then(function() {
            if (audio.src) audio.play().catch(function() {});
        });
    });

    function updateProgress() {
        if (audio.duration && isFinite(audio.duration)) {
            var pct = (audio.currentTime / audio.duration) * 100;
            progressBar.style.width = pct + '%';
        }
        if (isPlaying) {
            _progressRAF = requestAnimationFrame(updateProgress);
        }
    }

    audio.addEventListener('play', function() {
        cancelAnimationFrame(_progressRAF);
        _progressRAF = requestAnimationFrame(updateProgress);
    });
    audio.addEventListener('pause', function() { cancelAnimationFrame(_progressRAF); });
    audio.addEventListener('seeked', function() { updateProgress(); });

    if (progressWrap) {
        progressWrap.addEventListener('click', function(e) {
            if (!audio.duration || !isFinite(audio.duration)) return;
            var rect = progressWrap.getBoundingClientRect();
            var ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
            audio.currentTime = ratio * audio.duration;
        });
    }

    player.addEventListener('click', function(e) {
        if (e.target.closest('.music-btn') || e.target.closest('.music-progress-wrap')) return;
        player.classList.toggle('show-progress');
    });

    if (mode === 'custom') {
        loadSong('next').then(function () {
            audio.play().then(function () {
                // 直接播放成功
            }).catch(function () {
                // 静音绕过自动播放限制，等待任意交互后取消静音
                audio.muted = true;
                audio.play().then(function () {
                    function unmute() {
                        audio.muted = false;
                        document.removeEventListener('click', unmute);
                        document.removeEventListener('touchstart', unmute);
                        document.removeEventListener('keydown', unmute);
                        document.removeEventListener('scroll', unmute);
                    }
                    document.addEventListener('click', unmute, { once: true });
                    document.addEventListener('touchstart', unmute, { once: true });
                    document.addEventListener('keydown', unmute, { once: true });
                    document.addEventListener('scroll', unmute, { once: true });
                }).catch(function () {
                    // 连静音也失败，等待交互后带声播放
                    audio.muted = false;
                    function tryPlay() {
                        audio.play().catch(function () { });
                        document.removeEventListener('click', tryPlay);
                        document.removeEventListener('touchstart', tryPlay);
                        document.removeEventListener('keydown', tryPlay);
                    }
                    document.addEventListener('click', tryPlay, { once: true });
                    document.addEventListener('touchstart', tryPlay, { once: true });
                    document.addEventListener('keydown', tryPlay, { once: true });
                });
            });
        });
    }
})();
