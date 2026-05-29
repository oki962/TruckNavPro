export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    const { points, travelMode, dims } = req.body;

    if (!points) {
        return res.status(400).json({ error: 'Missing required parameter "points"' });
    }

    const tomtomKey = process.env.TOMTOM_KEY;
    if (!tomtomKey) {
        return res.status(500).json({ error: 'TOMTOM_KEY is not configured on the server' });
    }

    try {
        const url = `https://api.tomtom.com/routing/1/calculateRoute/${points}/json?key=${tomtomKey}&travelMode=${travelMode || 'truck'}&vehicleCommercial=true${dims || ''}&traffic=true&maxAlternatives=2`;

        const response = await fetch(url);
        const data = await response.json();

        if (!response.ok) {
            return res.status(response.status).json(data);
        }

        res.status(200).json(data);
    } catch (error) {
        console.error("Error calculating route:", error);
        res.status(500).json({ error: 'Internal Server Error calculating route' });
    }
}
