export default async function handler(req, res) {
    if (req.method !== 'GET') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    const { q, lat, lon } = req.query;
    if (!q) {
        return res.status(400).json({ error: 'Missing query parameter "q"' });
    }

    const tomtomKey = process.env.TOMTOM_KEY;
    if (!tomtomKey) {
        return res.status(500).json({ error: 'TOMTOM_KEY is not configured on the server' });
    }

    try {
        let tomtomUrl = `https://api.tomtom.com/search/2/search/${encodeURIComponent(q)}.json?key=${tomtomKey}&language=pl-PL&limit=5&typeahead=true`;
        if (lat && lon) {
            tomtomUrl += `&lat=${lat}&lon=${lon}`;
        }

        const response = await fetch(tomtomUrl);
        const data = await response.json();

        if (!response.ok) {
            return res.status(response.status).json(data);
        }

        res.status(200).json(data);
    } catch (error) {
        console.error("Error fetching from TomTom:", error);
        res.status(500).json({ error: 'Internal Server Error fetching search results' });
    }
}
