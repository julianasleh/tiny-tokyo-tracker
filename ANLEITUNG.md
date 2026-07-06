# ⛩ Tiny Tokyo Tracker – Anleitung

Web-App zum Sammeln, Bewerten und Handeln von TCG-Karten (Pokémon, Magic,
Yu-Gi-Oh, One Piece) – mit Community-Marktplatz, Trade-System und Profilen.

Die App läuft komplett im Browser. Daten liegen pro Nutzer in einer
Supabase-Cloud-Datenbank; gehostet wird über GitHub Pages.

---

## 1. Aufbau

- **`public/`** – die komplette App. Der INHALT dieses Ordners wird bei
  GitHub hochgeladen (index.html, legal.html, content.js, config.js, …, lib/).
- **`supabase-schema.sql`** – Grund-Schema (einmalig, bereits eingerichtet).
- **`supabase-community.sql` bis `-10.sql`** – Erweiterungen, in NUMMERN-
  REIHENFOLGE einmalig im Supabase-SQL-Editor ausführen (New query → Run).
  Alle Skripte sind mehrfach ausführbar, ohne Schaden anzurichten.
  - **NEU – `supabase-community-9.sql`**: Freunde, Chat-Räume und Forum.
    **Muss ausgeführt werden**, sonst zeigen die neuen Community-Reiter
    „Wurde die neue SQL-Datei ausgeführt?". Der Live-Chat und der Online-
    Status brauchen zusätzlich, dass **Realtime** aktiv ist (in Supabase
    unter *Database → Replication* ist die Publikation `supabase_realtime`
    standardmäßig an; das Skript trägt die Chat-Tabelle automatisch ein).
  - **NEU – `supabase-community-10.sql`**: Marktplatz-Gesuche (was Sammler
    suchen). Muss ausgeführt werden, sonst zeigt der Reiter Marktplatz →
    Gesuche „Wurde supabase-community-10.sql ausgeführt?".

## 2. Update einspielen

1. Zip entpacken (Rechtsklick → „Alle extrahieren" – NICHT aus dem
   Zip-Fenster ziehen!)
2. Falls die Zip neue `supabase-…sql`-Teile enthält: im Supabase-SQL-Editor
   ausführen.
3. GitHub-Repo → „Add file → Upload files" → Inhalt von `public/`
   (inkl. `lib`-Ordner) hineinziehen → Commit.
4. 1–2 Minuten warten, Seite mit Strg+F5 neu laden.

## 3. Inhalte selbst anpassen

- **Dashboard/Shop-Infos** (Adresse, Öffnungszeiten, News, Preis-Hinweis):
  Datei **`public/content.js`** direkt auf GitHub bearbeiten (Stift-Symbol).
- **Impressum/Datenschutz/Disclaimer**: `public/legal.html`.
- **Turnstile-Site-Key** (Bot-Schutz): `public/config.js`.

## 4. Einmalige Einstellungen in Supabase

- **Site URL** (für Passwort-Reset-Mails): Authentication → URL
  Configuration → Site URL = deine GitHub-Pages-Adresse.
- **E-Mail-Bestätigung**: Authentication → Providers → Email →
  „Confirm email" aktivieren.
- **Bot-Schutz**: Authentication → Attack Protection → CAPTCHA → Turnstile →
  Secret Key von Cloudflare eintragen (Site Key gehört in `config.js`).
- **„Verified"-Abzeichen vergeben** (User-ID unter Authentication → Users):
  `insert into user_badges (user_id, badge) values ('<USER_ID>', 'verified');`

## 5. Funktionen in Kürze

**Suche** – mehrsprachig inkl. Japanisch/Chinesisch (Namen werden automatisch
übersetzt, Zusätze wie „ex"/„VMAX" bleiben erhalten), Filter nach Set,
Seltenheit, Sprache, „nur mit Preis"; Nummernsuche (z. B. „SV8a 236").

**Sammlung** – Unterbereiche Einzelkarten / Versiegelt / Graded / Verkauft.
Preise aktualisieren sich automatisch (max. 1×/24 h beim Start). Duplikate
werden beim Hinzufügen erkannt. Export: Excel, CSV, Komplett-Backup (JSON),
druckbare Bestandsliste.

**Wunschliste** – mit Zielpreis-Alarm; Treffer in der Community werden
gemeldet.

**Community** – Angebote (Sammlung → ✎ → „Zum Verkauf anbieten"), Trades
(Anfrage → Annahme → beidseitige Bestätigung → automatische Umbuchung der
Karte), Feedback nur nach echtem Trade (👍/👎, Kategorien), Postfach,
Rangliste mit Leveln.

**Profile** – klickbar überall: Statistiken, Erfolgsquote, Vertrauens-
indikatoren (Antwortzeit, Aktivität, E-Mail bestätigt), Abzeichen, Erfolge,
Lieblings-TCGs und Sammler-Typ (einstellbar unter Einstellungen →
Community-Profil).

## 6. Grenzen (ehrlich)

- Japanisch-/chinesisch-exklusive Karten haben oft keine automatischen
  Preise (Datenlage der kostenlosen Quellen) – Wert manuell pflegen.
- Preise versiegelter Ware gibt es nicht gratis – eigenes Wert-Feld.
- Nachrichten/Trades sieht man beim Öffnen der App (keine Push-Mitteilungen).
- Punkte/Level sind Motivation, kein fälschungssicheres System – das
  fälschungssichere Signal sind abgeschlossene Trades + Feedback.
