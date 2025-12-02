// script.js
// Snow Day Predictor - Client-side logic
// No API keys required: uses zippopotam.us and open-meteo

const predictBtn = document.getElementById('predictBtn');
const exampleBtn = document.getElementById('exampleBtn');
const zipInput = document.getElementById('zip');
const loadingEl = document.getElementById('loading');
const resultEl = document.getElementById('result');
const verdictEl = document.getElementById('verdict');
const reasonList = document.getElementById('reasonList');
const weatherList = document.getElementById('weatherList');
const trendBlock = document.getElementById('trendBlock');
const scoreLine = document.getElementById('scoreLine');

predictBtn.addEventListener('click', () => {
  const zip = zipInput.value.trim();
  if (!zip) return alert('Please enter a ZIP code.');
  run(zip);
});
exampleBtn.addEventListener('click', () => {
  zipInput.value = '22153';
  run('22153');
});

async function run(zip) {
  showLoading(true);
  clearResult();

  try {
    // 1) Convert ZIP -> lat/lon
    const loc = await lookupZip(zip);
    if (!loc) throw new Error('Unable to find coordinates for that ZIP.');

    // 2) Load school trends JSON
    const trends = await fetch('./school_trends.json').then(r => r.json()).catch(() => ({}));
    const profile = trends[zip] || null;

    // 3) Fetch weather info (open-meteo)
    const weather = await fetchWeather(loc.lat, loc.lon);
    if (!weather) throw new Error('Weather fetch failed.');

    // 4) Compute score
    const {score, reasons} = computeScore(weather, profile);

    // 5) Render
    renderResult({zip, loc, weather, profile, score, reasons});
  } catch (err) {
    alert('Error: ' + err.message);
    console.error(err);
  } finally {
    showLoading(false);
  }
}

function showLoading(on) {
  loadingEl.classList.toggle('hidden', !on);
}

function clearResult() {
  resultEl.classList.add('hidden');
  verdictEl.textContent = '';
  reasonList.innerHTML = '';
  weatherList.innerHTML = '';
  trendBlock.textContent = '';
  scoreLine.innerHTML = '';
}

// ZIP -> lat/lon via zippopotam.us
async function lookupZip(zip) {
  const url = `https://api.zippopotam.us/us/${encodeURIComponent(zip)}`;
  const r = await fetch(url);
  if (!r.ok) return null;
  const data = await r.json();
  // pick first place
  const place = data.places && data.places[0];
  return place ? {lat: place.latitude, lon: place.longitude, placeName: `${place['place name']}, ${data['state abbreviation']}`} : null;
}

// Fetch current + daily forecast from Open-Meteo
async function fetchWeather(lat, lon) {
  // open-meteo daily snowfall_sum, temperature, wind, hourly precipitation; timezone autodetect by lat/lon with param
  const params = new URLSearchParams({
    latitude: lat,
    longitude: lon,
    timezone: 'auto',
    // request daily snowfall_sum and temps for next days
    daily: ['snowfall_sum','temperature_2m_max','temperature_2m_min','precipitation_sum'].join(','),
    // current weather
    current_weather: 'true',
    // hourly snowfall and precipitation (optional)
    hourly: ['snowfall','precipitation','temperature_2m'].join(',')
  });

  const url = `https://api.open-meteo.com/v1/forecast?${params.toString()}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error('Open-Meteo returned error');
  const data = await r.json();

  // We'll compute "tomorrow" as the second daily index (0=today,1=tomorrow) when available
  const daily = data.daily || {};
  const tomorrowIndex = 1;
  const t = {
    current: data.current_weather || null,
    daily: {
      date: (daily.time && daily.time[tomorrowIndex]) || null,
      snowfall_sum: (daily.snowfall_sum && daily.snowfall_sum[tomorrowIndex]) || 0,
      precipitation_sum: (daily.precipitation_sum && daily.precipitation_sum[tomorrowIndex]) || 0,
      temp_max: (daily.temperature_2m_max && daily.temperature_2m_max[tomorrowIndex]) || null,
      temp_min: (daily.temperature_2m_min && daily.temperature_2m_min[tomorrowIndex]) || null
    },
    raw: data
  };

  return t;
}

// Scoring rules (simple, extensible)
function computeScore(weather, profile) {
  let score = 0;
  const reasons = [];

  // 1) Forecasted snow amount (daily snowfall_sum)
  const snowInches = Number(weather.daily.snowfall_sum || 0);
  if (snowInches >= 6) {
    score += 5;
    reasons.push(`Forecasted snow: ${snowInches} in → +5`);
  } else if (snowInches >= 3) {
    score += 3;
    reasons.push(`Forecasted snow: ${snowInches} in → +3`);
  } else if (snowInches >= 1) {
    score += 1;
    reasons.push(`Forecasted snow: ${snowInches} in → +1`);
  } else {
    reasons.push(`Forecasted snow: ${snowInches} in → +0`);
  }

  // 2) Current weather (+3 if currently heavy snow)
  const current = weather.current;
  if (current && typeof current.weathercode !== 'undefined') {
    // Open-Meteo weathercode: 71–75 light to heavy snow, 77 snow grains, 85–86 snowfall etc.
    const wc = current.weathercode;
    if (wc >= 71 && wc <= 86) {
      score += 2;
      reasons.push(`Active snow now (weather code ${wc}) → +2`);
    }
  }

  // 3) Temperature effect
  const tomorrowMin = Number(weather.daily.temp_min);
  if (!isNaN(tomorrowMin)) {
    if (tomorrowMin <= 15) {
      score += 2;
      reasons.push(`Tomorrow low ${tomorrowMin}°F → +2`);
    } else if (tomorrowMin <= 25) {
      score += 1;
      reasons.push(`Tomorrow low ${tomorrowMin}°F → +1`);
    } else {
      reasons.push(`Tomorrow low ${tomorrowMin}°F → +0`);
    }
  }

  // 4) Precipitation timing/volume (if precipitation_sum is large)
  const precip = Number(weather.daily.precipitation_sum || 0);
  if (precip >= 10) {
    score += 2;
    reasons.push(`High precip volume ${precip} mm → +2`);
  } else if (precip >= 3) {
    score += 1;
    reasons.push(`Moderate precip ${precip} mm → +1`);
  } else {
    reasons.push(`Precip ${precip} mm → +0`);
  }

  // 5) Local school profile influence
  if (profile) {
    const histWeight = Number(profile.historical_closure_weight || 0); // 0..5
    // If forecast snow >= local threshold, give a big boost
    const thresh = Number(profile.closure_inch_threshold || 999);
    if (!isNaN(thresh) && snowInches >= thresh) {
      const boost = Math.min(4, Math.max(1, Math.round(histWeight)));
      score += boost;
      reasons.push(`Local rule: forecast >= ${thresh} in and historical weight ${histWeight} → +${boost}`);
    } else {
      // if historical bias present, add small nudge
      if (profile.bias_when_snow_overnight && snowInches > 0) {
        score += Math.min(2, Math.round(Number(profile.bias_when_snow_overnight)));
        reasons.push(`Local overnight bias → +${Math.min(2, Math.round(Number(profile.bias_when_snow_overnight)))}`);
      } else {
        reasons.push(`Local profile present but no threshold met → +0`);
      }
    }

    // extreme cold threshold
    const coldThresh = Number(profile.closure_temp_threshold_f || 0);
    if (!isNaN(coldThresh) && tomorrowMin <= coldThresh) {
      score += 1;
      reasons.push(`Local cold threshold ${coldThresh}°F triggered (tomorrow min ${tomorrowMin}) → +1`);
    }
  } else {
    reasons.push('No local profile found for this ZIP (edit school_trends.json to add it).');
  }

  // 6) Range/limits and rounding
  // Ensure score is numeric
  score = Math.max(0, Math.round(score));

  return {score, reasons};
}

function renderResult({zip, loc, weather, profile, score, reasons}) {
  resultEl.classList.remove('hidden');

  // verdict
  let verdictText = '';
  let badgeClass = '';
  if (score >= 8) {
    verdictText = 'Very likely: Snow day expected';
    badgeClass = 'badge-bad';
  } else if (score >= 5) {
    verdictText = 'Possible: Snow day 50/50';
    badgeClass = 'badge-maybe';
  } else {
    verdictText = 'Unlikely: School likely open';
    badgeClass = 'badge-good';
  }

  verdictEl.innerHTML = `<span class="badge ${badgeClass}">${verdictText}</span> — Score: ${score}`;

  // score bar (0..12)
  const max = 12;
  const pct = Math.min(100, Math.round((score / max) * 100));
  scoreLine.innerHTML = `<div class="score-fill" style="width:${pct}%; background:linear-gradient(90deg, #60a5fa, #6366f1)"></div>`;

  // reasons
  reasonList.innerHTML = '';
  reasons.forEach(r => {
    const li = document.createElement('li');
    li.textContent = r;
    reasonList.appendChild(li);
  });

  // weather summary
  weatherList.innerHTML = '';
  const wli = (t) => {
    const li = document.createElement('li');
    li.textContent = t;
    weatherList.appendChild(li);
  };

  wli(`Location: ${loc.placeName || `${loc.lat}, ${loc.lon}`} (ZIP ${zip})`);
  if (weather.current) {
    wli(`Now: ${weather.current.temperature}°C, wind ${weather.current.windspeed} m/s, weathercode ${weather.current.weathercode}`);
  }
  const d = weather.daily;
  wli(`Tomorrow date: ${d.date}`);
  wli(`Tomorrow snowfall (daily): ${d.snowfall_sum} in (note: Open-Meteo returns snowfall in mm vs inches depending — we treat as inches if value seems small)`);
  wli(`Tomorrow min: ${d.temp_min}, max: ${d.temp_max}`);
  wli(`Tomorrow precipitation: ${d.precipitation_sum} mm`);

  // show profile
  trendBlock.textContent = profile ? JSON.stringify(profile, null, 2) : 'No local profile found. Add an entry to school_trends.json for this ZIP to improve predictions.';
}
