export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const { title, message } = req.body;

  const params = new URLSearchParams();
  params.append('token', process.env.PUSHOVER_TOKEN);
  params.append('user', process.env.PUSHOVER_USER);
  params.append('title', title || ' ');
  params.append('message', message || '');
  params.append('sound', 'cashregister');

  const r = await fetch('https://api.pushover.net/1/messages.json', {
    method: 'POST',
    body: params,
  });

  const data = await r.json();
  return res.status(200).json(data);
}
