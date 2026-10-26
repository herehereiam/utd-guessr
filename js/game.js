(() => {
  'use strict';

  const TIME_ZONE = 'America/Chicago';
  const CAMPUS = [32.9857, -96.7501]; // UT Dallas, Richardson, Texas
  const MAX_SCORE = 5000;
  const REVEAL_PENALTY = 1000;
  const MAX_REVEALS = 3;
  const MAX_SCORE_DISTANCE_METERS = 22.86;
  const MAP_DIAMETER_METERS = 1850;
  const FUDGE_FACTOR = -8.01;
  const STORAGE_PREFIX = 'UTDGuessr';

  const el = (id) => document.getElementById(id);
  const ui = {
    archive: el('archive-select'),
    notice: el('notice'),
    content: el('game-content'),
    heading: el('puzzle-heading'),
    canvas: el('puzzle-canvas'),
    preGuess: el('pre-guess-controls'),
    postGuess: el('post-guess-stages'),
    reveal: el('reveal-button'),
    pointsPossible: el('points-possible'),
    mapInstructions: el('map-instructions'),
    map: el('map'),
    submit: el('submit-guess-button'),
    resultPanel: el('result-panel'),
    score: el('score-value'),
    distance: el('distance-value'),
    resultReveals: el('result-reveals'),
    resultMessage: el('result-message'),
    copy: el('copy-button'),
    copyFeedback: el('copy-feedback')
  };

  let manifest = null;
  let puzzlesByDate = new Map();
  let currentPuzzle = null;
  let currentDate = null;
  let image = null;
  let naturalSize = null;
  let stage = 1;
  let reveals = 0;
  let guess = null;
  let result = null;
  let guessMarker = null;
  let trueMarker = null;
  let distanceLine = null;
  let map = null;
  let mapReady = false;

  // Keep the stage selector beside the image so it is available
  // before and after guessing.
  //if (ui.canvas && ui.postGuess) {
  //  ui.canvas.insertAdjacentElement('afterend', ui.postGuess);
  //  ui.postGuess.hidden = false;
  //}

  function centralDateKey(date = new Date()) {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: TIME_ZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).formatToParts(date);

    const values = Object.fromEntries(
      parts.map(part => [part.type, part.value])
    );

    return `${values.year}-${values.month}-${values.day}`;
  }

  function prettyDate(dateKey) {
    const [year, month, day] = dateKey.split('-').map(Number);

    return new Intl.DateTimeFormat(undefined, {
      month: 'long',
      day: 'numeric',
      year: 'numeric',
      timeZone: 'UTC'
    }).format(new Date(Date.UTC(year, month - 1, day)));
  }

  async function getJson(url) {
    const response = await fetch(url, { cache: 'no-cache' });

    if (!response.ok) {
      throw new Error(`Could not load ${url} (${response.status}).`);
    }

    return response.json();
  }

  function showNotice(message) {
    ui.notice.textContent = message;
    ui.notice.hidden = false;
    ui.content.hidden = true;
  }

  function hideNotice() {
    ui.notice.hidden = true;
    ui.content.hidden = false;
  }

  function storageKey(dateKey) {
    return `${STORAGE_PREFIX}${dateKey}`;
  }

  function loadSavedState(dateKey) {
    try {
      const raw = localStorage.getItem(storageKey(dateKey));

      if (!raw) {
        return {
          stage: 1,
          reveals: 0,
          guess: null,
          result: null
        };
      }

      const saved = JSON.parse(raw);

      return {
        stage: Number.isInteger(saved.stage)
          ? Math.min(4, Math.max(1, saved.stage))
          : 1,

        reveals: Number.isInteger(saved.reveals)
          ? Math.min(MAX_REVEALS, Math.max(0, saved.reveals))
          : 0,

        guess: saved.guess &&
          Number.isFinite(saved.guess.lat) &&
          Number.isFinite(saved.guess.lng)
            ? saved.guess
            : null,

        result: saved.result &&
          Number.isFinite(saved.result.score)
            ? saved.result
            : null
      };
    } catch (_) {
      return {
        stage: 1,
        reveals: 0,
        guess: null,
        result: null
      };
    }
  }

  function saveState() {
    if (!currentDate) return;

    try {
      localStorage.setItem(
        storageKey(currentDate),
        JSON.stringify({ stage, reveals, guess, result })
      );
    } catch (_) {
      // The game remains playable if browser storage is disabled or full.
    }
  }

  function initMap() {
    if (mapReady || !window.L) return;

    map = L.map(ui.map, { zoomControl: true }).setView(CAMPUS, 15);

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
    }).addTo(map);

    map.on('click', event => {
      if (!currentPuzzle || result) return;

      guess = {
        lat: event.latlng.lat,
        lng: event.latlng.lng
      };

      if (guessMarker) {
        guessMarker.setLatLng(event.latlng);
      } else {
        guessMarker = L.marker(event.latlng, {
          title: 'Your guess'
        }).addTo(map).bindTooltip('Your guess');
      }

      ui.submit.disabled = false;
      saveState();
    });

    mapReady = true;
  }

  function clearMapLayers() {
    if (!mapReady) return;

    [guessMarker, trueMarker, distanceLine].forEach(layer => {
      if (layer) map.removeLayer(layer);
    });

    guessMarker = null;
    trueMarker = null;
    distanceLine = null;
  }

  function validatePuzzle(puzzle) {
    if (
      !puzzle ||
      !puzzle.image ||
      !Array.isArray(puzzle.cropStages) ||
      puzzle.cropStages.length !== 3 ||
      !puzzle.bullseye ||
      !puzzle.location
    ) {
      throw new Error('This puzzle is missing required fields.');
    }

    const { lat, lng } = puzzle.location;

    if (
      !Number.isFinite(lat) ||
      !Number.isFinite(lng) ||
      lat < -90 ||
      lat > 90 ||
      lng < -180 ||
      lng > 180
    ) {
      throw new Error('The puzzle latitude/longitude is invalid.');
    }

    for (const crop of puzzle.cropStages) {
      if (
        ![crop.x, crop.y, crop.width, crop.height].every(Number.isFinite) ||
        crop.x < 0 ||
        crop.y < 0 ||
        crop.width <= 0 ||
        crop.height <= 0
      ) {
        throw new Error('A crop stage has invalid pixel coordinates.');
      }
    }
  }

  function cropForStage(stageNumber) {
    if (stageNumber === 4) {
      return {
        x: 0,
        y: 0,
        width: naturalSize.width,
        height: naturalSize.height
      };
    }

    const crop = currentPuzzle.cropStages[stageNumber - 1];

    return {
      x: Math.max(0, Math.min(naturalSize.width, crop.x)),
      y: Math.max(0, Math.min(naturalSize.height, crop.y)),
      width: Math.max(
        1,
        Math.min(naturalSize.width - crop.x, crop.width)
      ),
      height: Math.max(
        1,
        Math.min(naturalSize.height - crop.y, crop.height)
      )
    };
  }

  function drawImageStage() {
    if (!image || !naturalSize) return;

    const crop = cropForStage(stage);
    const canvas = ui.canvas;
    const ctx = canvas.getContext('2d');

    canvas.width = Math.max(1, Math.round(crop.width));
    canvas.height = Math.max(1, Math.round(crop.height));

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    ctx.drawImage(
      image,
      crop.x,
      crop.y,
      crop.width,
      crop.height,
      0,
      0,
      canvas.width,
      canvas.height
    );

    // Draw the bullseye when its location is inside the current crop.
    if (currentPuzzle.bullseye) {
      const bx = currentPuzzle.bullseye.x - crop.x;
      const by = currentPuzzle.bullseye.y - crop.y;

      if (
        bx >= 0 &&
        by >= 0 &&
        bx <= crop.width &&
        by <= crop.height
      ) {
        const scale = canvas.width / crop.width;

        ctx.save();
        ctx.globalAlpha = 0.65;

        ctx.beginPath();
        ctx.arc(bx, by, 40 / scale, 0, Math.PI * 2);
        ctx.lineWidth = 10 / scale;
        ctx.strokeStyle = '#e11d48';
        ctx.stroke();

        ctx.beginPath();
        ctx.moveTo(bx - 70 / scale, by);
        ctx.lineTo(bx + 70 / scale, by);
        ctx.moveTo(bx, by - 70 / scale);
        ctx.lineTo(bx, by + 70 / scale);
        ctx.lineWidth = 10 / scale;
        ctx.stroke();

        ctx.restore();
      }
    }

    canvas.setAttribute(
      'aria-label',
      `${currentPuzzle.imageAlt || 'Puzzle image'}, stage ${stage} of 4`
    );

    ui.pointsPossible.textContent =
      (5000 - (1000 * reveals)).toLocaleString('en-US');

    // Enable every stage the player has unlocked.
    // Stage 1 is always available; each reveal unlocks one more stage.
    ui.postGuess.querySelectorAll('[data-stage]').forEach(button => {
      const buttonStage = Number(button.dataset.stage);
      const inaccessible = buttonStage > reveals + 1;

      button.disabled = inaccessible;
      button.classList.toggle('stage-inaccessible', inaccessible);

      button.setAttribute(
        'aria-pressed',
        buttonStage === stage ? 'true' : 'false'
      );
    });
  }

  function haversineMeters(a, b) {
    const rad = degrees => degrees * Math.PI / 180;
    const earthRadius = 6371008.8;

    const dLat = rad(b.lat - a.lat);
    const dLng = rad(b.lng - a.lng);
    const lat1 = rad(a.lat);
    const lat2 = rad(b.lat);

    const h =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(lat1) * Math.cos(lat2) *
      Math.sin(dLng / 2) ** 2;

    return 2 * earthRadius *
      Math.asin(Math.min(1, Math.sqrt(h)));
  }

  function calculateResult() {
    const distanceMeters = haversineMeters(
      guess,
      currentPuzzle.location
    );

    const availablePoints = Math.max(
      0,
      MAX_SCORE - reveals * REVEAL_PENALTY
    );

    const distanceFactor = Math.max(
      0,
      Math.min(
        1,
        Math.exp(
          FUDGE_FACTOR *
          (distanceMeters - MAX_SCORE_DISTANCE_METERS) /
          MAP_DIAMETER_METERS
        )
      )
    );

    const score = Math.round(availablePoints * distanceFactor);

    return {
      score,
      distanceMeters,
      availablePoints,
      distanceFactor,
      reveals
    };
  }

  function formatDistance(meters) {
    if (meters < 161) {
      return `${Math.round(meters * 3.28084)} ft`;
    }

    return `${(meters * 0.000621371).toFixed(2)} mi`;
  }

  function showResult() {
    ui.resultPanel.hidden = false;
    ui.score.textContent = result.score.toLocaleString('en-US');
    ui.distance.textContent = formatDistance(result.distanceMeters);
    ui.resultReveals.textContent = `${reveals} / ${MAX_REVEALS}`;

    ui.resultMessage.textContent =
      result.score === 5000
        ? 'Incredible!!'
        : result.distanceMeters < MAX_SCORE_DISTANCE_METERS
          ? 'Amazing accuracy!'
          : result.score === 0
            ? 'Maybe next time.'
            : '';

    ui.copyFeedback.textContent = '';
    ui.copy.textContent = 'Copy results';
  }

  function lockGuess() {
    if (!guess || result) return;

    result = calculateResult();
    stage = Math.max(1, Math.min(4, stage));

    saveState();

    ui.preGuess.hidden = true;
    ui.postGuess.hidden = false;
    ui.reveal.disabled = true;
    ui.submit.disabled = true;

    ui.mapInstructions.textContent =
      'Your guess and the true location are shown below.';

    showResult();
    revealTrueLocation();
    drawImageStage();
  }

  function revealTrueLocation() {
    if (!mapReady || !currentPuzzle || !result) return;

    const target = [
      currentPuzzle.location.lat,
      currentPuzzle.location.lng
    ];

    const player = [guess.lat, guess.lng];

    distanceLine = L.polyline([player, target], {
      color: '#13795b',
      weight: 3,
      dashArray: '7 7',
      opacity: 0.85
    }).addTo(map);

    trueMarker = L.circleMarker(target, {
      radius: 10,
      color: '#e11d48',
      weight: 4
    }).addTo(map).bindTooltip('True location');

    const bounds = L.latLngBounds([player, target]).pad(0.25);

    map.fitBounds(bounds, { maxZoom: 17 });
  }

  function renderState() {
    const hasResult = Boolean(result);

    ui.preGuess.hidden = hasResult;
    ui.postGuess.hidden = false;
    ui.resultPanel.hidden = !hasResult;

    ui.reveal.disabled = hasResult || reveals >= MAX_REVEALS;

    ui.reveal.innerHTML =
      reveals >= MAX_REVEALS
        ? 'Full image revealed'
        : `Reveal more <span>−${REVEAL_PENALTY.toLocaleString('en-US')} pts</span>`;

    ui.submit.disabled = hasResult || !guess;

    ui.mapInstructions.textContent = hasResult
      ? 'Your guess and the true location are shown below.'
      : 'Drop a pin where you think the crosshair in the image is. You only get one guess.';

    ui.heading.textContent = currentPuzzle.title || 'Photo clue';

    if (hasResult) showResult();

    drawImageStage();
  }

  async function loadPuzzle(dateKey) {
    const entry = puzzlesByDate.get(dateKey);

    if (!entry) {
      showNotice(
        `There is no puzzle published for ${prettyDate(dateKey)} yet.`
      );
      currentPuzzle = null;
      return;
    }

    try {
      const puzzle = await getJson(
        `data/puzzles/${entry.file}.json`
      );

      validatePuzzle(puzzle);

      currentPuzzle = puzzle;
      currentDate = dateKey;

      const saved = loadSavedState(dateKey);

      stage = saved.stage;
      reveals = saved.reveals;
      guess = saved.guess;
      result = saved.result;

      if (result && !guess) result = null;

      if (!result) {
        stage = Math.min(4, reveals + 1);
      }

      hideNotice();
      clearMapLayers();

      ui.resultPanel.hidden = true;
      ui.copyFeedback.textContent = '';

      image = new Image();

      image.onload = () => {
        naturalSize = {
          width: image.naturalWidth,
          height: image.naturalHeight
        };

        for (const crop of puzzle.cropStages) {
          if (
            crop.x + crop.width > naturalSize.width ||
            crop.y + crop.height > naturalSize.height
          ) {
            console.warn(
              `Crop rectangle extends beyond ${puzzle.image}; it will be clipped.`
            );
          }
        }

        renderState();

        if (guess && mapReady) {
          guessMarker = L.marker(
            [guess.lat, guess.lng],
            { title: 'Your guess' }
          ).addTo(map).bindTooltip('Your guess');

          if (result) {
            revealTrueLocation();
          } else {
            map.setView(
              [guess.lat, guess.lng],
              Math.max(map.getZoom(), 15)
            );
          }
        } else if (mapReady) {
          map.setView(CAMPUS, 15);
        }
      };

      image.onerror = () => {
        showNotice(`The image could not be loaded: ${puzzle.image}.`);
      };

      image.src = `images/${puzzle.image}`;
    } catch (error) {
      console.error(error);

      showNotice(
        `Could not load the puzzle for ${prettyDate(dateKey)}. ${error.message}`
      );
    }
  }

  function populateArchive(today) {
    const dates = [...puzzlesByDate.keys()]
      .sort((a, b) => b.localeCompare(a));

    ui.archive.innerHTML = '';

    for (const date of dates) {
      if (date > today) { continue; }

      const option = document.createElement('option');

      option.value = date;
      option.textContent =
        `${date === today ? 'Today — ' : ''}${prettyDate(date)}`;

      //if (date > today) option.disabled = true;

      ui.archive.appendChild(option);
    }

    if (!puzzlesByDate.has(today)) {
      const option = document.createElement('option');

      option.value = today;
      option.textContent =
        `Today — ${prettyDate(today)} (not published yet)`;

      ui.archive.insertBefore(option, ui.archive.firstChild);
    }

    ui.archive.value = puzzlesByDate.has(today) ? today : today;
  }

  ui.reveal.addEventListener('click', () => {
    if (!currentPuzzle || result || reveals >= MAX_REVEALS) return;

    reveals += 1;
    stage = Math.min(4, reveals + 1);

    saveState();
    renderState();
  });

  ui.submit.addEventListener('click', lockGuess);

  // Clicking an unlocked stage changes the image without using a reveal.
  ui.postGuess.querySelectorAll('[data-stage]').forEach(button => {
    button.addEventListener('click', () => {
      const selectedStage = Number(button.dataset.stage);

      if (selectedStage > reveals + 1) return;

      stage = selectedStage;
      saveState();
      drawImageStage();
    });
  });

  ui.archive.addEventListener('change', () => {
    if (ui.archive.value) {
      loadPuzzle(ui.archive.value);
    }
  });

  ui.copy.addEventListener('click', async () => {
    if (!result) return;

    const scoreEmoji =
      result.score === 5000 ? '🌟'
      : result.score >= 4000 ? '⭐'
      : result.score >= 3000 ? '🔥'
      : result.score >= 2000 ? '🕯️'
      : result.score >= 1000 ? '❄️'
      : '🧊';

    const revealsEmoji =
      reveals === 0 ? '☐☐☐'
      : reveals === 1 ? '☒☐☐'
      : reveals === 2 ? '☒☒☐'
      : '☒☒☒';

    const shareText =
      `UTDGuessr 📍 ${prettyDate(currentDate)}\n` +
      `Score: ${result.score.toLocaleString('en-US')} / ${MAX_SCORE.toLocaleString('en-US')} ${scoreEmoji}\n` +
      `Distance: ${formatDistance(result.distanceMeters)}\n` +
      `Reveals: ${revealsEmoji}\n` +
      `https://herehereiam.github.io/utd-guessr/`;

    try {
      await navigator.clipboard.writeText(shareText);
      ui.copyFeedback.textContent = 'Copied to clipboard!';
    } catch (_) {
      const temporary = document.createElement('textarea');

      temporary.value = shareText;
      temporary.setAttribute('readonly', '');
      temporary.style.position = 'fixed';
      temporary.style.opacity = '0';

      document.body.appendChild(temporary);
      temporary.select();

      const copied = document.execCommand('copy');

      temporary.remove();

      ui.copyFeedback.textContent = copied
        ? 'Copied to clipboard!'
        : 'Clipboard unavailable. You can copy the result manually.';
    }
  });

  async function start() {
    const today = centralDateKey();

    try {
      manifest = await getJson('data/index.json');

      puzzlesByDate = new Map(
        (manifest.puzzles || []).map(entry => [entry.date, entry])
      );

      populateArchive(today);
      initMap();

      await loadPuzzle(ui.archive.value || today);

      if (!mapReady) {
        showNotice(
          'The map library did not load. Check your internet connection and try again.'
        );
      }

      // Leaflet needs a size refresh after its initially hidden parent becomes visible.
      if (mapReady) {
        setTimeout(() => map.invalidateSize(), 100);
      }
    } catch (error) {
      console.error(error);

      showNotice(
        `The game could not start. ${error.message} If you opened index.html directly, run a local web server or publish the folder to static hosting.`
      );
    }
  }

  start();
})();