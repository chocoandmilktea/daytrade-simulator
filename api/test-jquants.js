export default async function handler(req, res) {
  const apiKey = process.env.JQUANTS_API_KEY;
  const url = "https://api.jquants.com/v2/equities/bars/minute?code=72030&date=20260624";
  
  const r = await fetch(url, { headers: { "x-api-key": apiKey } });
  const json = await r.json();
  
  return res.status(r.status).json(json);
}
