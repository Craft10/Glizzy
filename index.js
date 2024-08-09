const express = require('express');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const bodyParser = require('body-parser');
const { v4: uuidv4 } = require('uuid');
const http = require('http');
const WebSocket = require('ws');
const db = new sqlite3.Database('database.db');
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const port = process.env.PORT || 3000;

app.set('view engine', 'ejs');
app.use(express.static(path.join(__dirname, 'public')));
app.set('views', path.join(__dirname, 'views'));
app.use(bodyParser.json());

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS blacklist (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ip TEXT NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS visits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ip TEXT NOT NULL,
      visit_count INTEGER DEFAULT 1,
      last_visit DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS tickets (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      status TEXT DEFAULT 'open',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id TEXT NOT NULL,
      message TEXT NOT NULL,
      sent_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
});

let isMaintenanceMode = false;

app.set('trust proxy', true);

const normalizeIp = (ip) => ip.startsWith('::ffff:') ? ip.slice(7) : ip;

const isPrivateIp = (ip) => {
  const blocks = ip.split('.').map(Number);
  return (
    blocks[0] === 10 || 
    (blocks[0] === 172 && blocks[1] >= 16 && blocks[1] <= 31) || 
    (blocks[0] === 192 && blocks[1] === 168)
  );
};

async function fetchIPInfo(ip) {
  const response = await fetch(`http://ip-api.com/json/${ip}`);
  const data = await response.json();
  return data;
}

app.use((req, res, next) => {
  if (isMaintenanceMode) {
    return res.status(503).render('maintenance');
  }
  next();
});

app.use((req, res, next) => {
  const ip = req.headers['x-forwarded-for'] ? req.headers['x-forwarded-for'].split(',')[0].trim() : req.socket.remoteAddress;
  const normalizedIp = normalizeIp(ip);

  if (isPrivateIp(normalizedIp)) {
    console.log(`IP privada detectada y filtrada: ${normalizedIp}`);
    return next();
  }

  db.get('SELECT * FROM blacklist WHERE ip = ?', [normalizedIp], (err, row) => {
    if (err) {
      console.error('Error del servidor:', err);
      return res.status(500).send('Error del servidor');
    }

    if (row) {
      console.log(`Acceso denegado: IP ${normalizedIp} en blacklist`);
      return res.status(403).send('Acceso denegado: IP en blacklist');
    }

    db.get('SELECT * FROM visits WHERE ip = ?', [normalizedIp], (err, row) => {
      if (err) {
        console.error('Error del servidor:', err);
        return res.status(500).send('Error del servidor');
      }

      if (row) {
        db.run('UPDATE visits SET visit_count = visit_count + 1, last_visit = CURRENT_TIMESTAMP WHERE ip = ?', [normalizedIp], (err) => {
          if (err) {
            console.error('Error al actualizar la visita:', err);
          } else {
            console.log(`IP ${normalizedIp} visitó el sitio. Visita #${row.visit_count + 1}`);
          }
        });
      } else {
        db.run('INSERT INTO visits (ip) VALUES (?)', [normalizedIp], (err) => {
          if (err) {
            console.error('Error al registrar la visita:', err);
          } else {
            console.log(`IP ${normalizedIp} visitó el sitio por primera vez.`);
          }
        });
      }

      next();
    });
  });
});

// Tickets Routes
app.get('/ticket/:uuid', (req, res) => {
  const { uuid } = req.params;

  db.get('SELECT * FROM tickets WHERE id = ?', [uuid], (err, ticket) => {
    if (err) {
      console.error('Error del servidor:', err);
      return res.status(500).send('Error del servidor');
    }

    if (!ticket) {
      return res.status(404).send('Ticket no encontrado');
    }

    db.all('SELECT * FROM messages WHERE ticket_id = ?', [uuid], (err, messages) => {
      if (err) {
        console.error('Error del servidor:', err);
        return res.status(500).send('Error del servidor');
      }

      res.render('chat', { ticket, messages });
    });
  });
});

app.post('/ticket/create', (req, res) => {
  const { title } = req.body;
  const uuid = uuidv4(); // Generar un UUID para el ticket

  db.run('INSERT INTO tickets (id, title) VALUES (?, ?)', [uuid, title], (err) => {
    if (err) {
      console.error('Error al crear el ticket:', err);
      return res.status(500).send('Error del servidor');
    }

    res.redirect(`/ticket/${uuid}`);
  });
});

// WebSocket logic
wss.on('connection', ws => {
  ws.on('message', message => {
    const data = JSON.parse(message);
    if (data.action === 'send') {
      const { ticketId, text } = data;
      db.run('INSERT INTO messages (ticket_id, message) VALUES (?, ?)', [ticketId, text], err => {
        if (err) {
          console.error('Error insertando mensaje:', err);
        } else {
          wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
              client.send(JSON.stringify({ action: 'newMessage', ticketId, text }));
            }
          });
        }
      });
    }
  });
});

app.get('/', async (req, res) => {
  res.render('index');
});

app.get('/visits', async (req, res) => {
  db.all(`
    SELECT visits.ip, visits.visit_count, visits.last_visit,
           CASE WHEN blacklist.ip IS NOT NULL THEN 'Sí' ELSE 'No' END AS is_blacklisted
    FROM visits
    LEFT JOIN blacklist ON visits.ip = blacklist.ip
  `, [], async (err, rows) => {
    if (err) {
      console.error('Error del servidor:', err);
      return res.status(500).send('Error del servidor');
    }

    try {
      const visitsWithInfo = await Promise.all(rows.map(async (visit) => {
        const ipInfo = await fetchIPInfo(visit.ip);
        return { ...visit, ipInfo };
      }));

      res.render('visits', { visits: visitsWithInfo });
    } catch (error) {
      console.error('Error fetching IP info:', error);
      res.status(500).send('Error fetching IP info');
    }
  });
});

app.post('/maintenance', (req, res) => {
  isMaintenanceMode = !isMaintenanceMode;
  res.send(`Modo de mantenimiento ${isMaintenanceMode ? 'activado' : 'desactivado'}`);
});

app.post('/blacklist', (req, res) => {
  const { ip, add_to_blacklist } = req.body;

  if (!ip) {
    return res.status(400).send('Falta la IP en el cuerpo de la solicitud');
  }

  const normalizedIp = normalizeIp(ip);

  if (add_to_blacklist === '1') {
    db.run('INSERT OR IGNORE INTO blacklist (ip) VALUES (?)', [normalizedIp], (err) => {
      if (err) {
        console.error('Error al agregar IP a la blacklist:', err);
        return res.status(500).send('Error del servidor');
      }
      console.log(`IP ${normalizedIp} agregada a la blacklist`);
      res.redirect('/visits'); 
    });
  } else {
    db.run('DELETE FROM blacklist WHERE ip = ?', [normalizedIp], (err) => {
      if (err) {
        console.error('Error al eliminar IP de la blacklist:', err);
        return res.status(500).send('Error del servidor');
      }
      console.log(`IP ${normalizedIp} eliminada de la blacklist`);
      res.redirect('/visits'); 
    });
  }
});

app.get('/ipinfo/:ip', async (req, res) => {
  try {
    const ipInfo = await fetchIPInfo(req.params.ip);
    res.json(ipInfo);
  } catch (error) {
    res.status(500).json({ error: 'Error fetching IP info' });
  }
});

server.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`);
});
