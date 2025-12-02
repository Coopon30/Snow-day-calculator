async function predict() {
    const zip = document.getElementById("zip").value.trim();
    const resultBox = document.getElementById("result");

    if (!zip) {
        resultBox.classList.remove("hidden");
        resultBox.innerHTML = `<p class="alert alert-warning">Please enter a ZIP code.</p>`;
        return;
    }

    resultBox.classList.remove("hidden");
    resultBox.innerHTML = `<p class="alert alert-info">Loading data...</p>`;

    try {
        // --- 1. Get ZIP → Coordinates
        const zipRes = await fetch(`https://api.zippopotam.us/us/${zip}`);
        if (!zipRes.ok) throw new Error("Invalid ZIP.");

        const zipData = await zipRes.json();
        const lat = zipData.places[0].latitude;
        const lon = zipData.places[0].longitude;

        // --- 2. Weather from Open-Meteo
        const weatherRes = await fetch(
            `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=temperature_2m,snowfall&daily=snowfall_sum,temperature_2m_min,temperature_2m_max&timezone=auto`
        );

        const weather = await weatherRes.json();
        const tomorrowSnow = weather.daily.snowfall_sum[1];
        const tomorrowLow = weather.daily.temperature_2m_min[1];

        // --- 3. Load school-trends JSON
        const trends = await fetch("data.json").then(r => r.json());
        const local = trends[zip] || {
            avg_closure_at_4in: 0.5,
            avg_closure_at_2in: 0.3,
            closure_temp_threshold: 20
        };

        // --- 4. Score system
        let score = 0;

        if (tomorrowSnow > 3) score += 4;
        else if (tomorrowSnow > 1) score += 2;

        if (tomorrowLow < 20) score += 1;

        if (tomorrowSnow >= 4) score += Math.round(local.avg_closure_at_4in * 4);
        else if (tomorrowSnow >= 2) score += Math.round(local.avg_closure_at_2in * 4);

        // --- 5. Determine result
        let message = "";
        let badgeClass = "";

        if (score >= 8) {
            message = "Snow Day Likely";
            badgeClass = "badge-likely";
        } else if (score >= 5) {
            message = "Possible Snow Day";
            badgeClass = "badge-possible";
        } else {
            message = "Snow Day Unlikely";
            badgeClass = "badge-unlikely";
        }

        // --- 6. Output
        resultBox.innerHTML = `
            <h2>Your Prediction</h2>
            <span class="prediction-badge ${badgeClass}">${message}</span>

            <div class="alert alert-info">
                Tomorrow Snow: <strong>${tomorrowSnow} in</strong><br>
                Tomorrow Low Temp: <strong>${tomorrowLow}°F</strong>
            </div>

            <div class="alert alert-warning">
                Historical Trend Score: <strong>${score}</strong>
            </div>
        `;

    } catch (err) {
        resultBox.innerHTML = `<p class="alert alert-danger">Error: ${err.message}</p>`;
    }
}
