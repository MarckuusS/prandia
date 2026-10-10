-- =============================================================================
-- Notifications : les appareils abonnes, ce que chacun veut recevoir, et ce qui
-- est deja parti.
--
-- TROIS TABLES CLOISONNEES PAR PERSONNE, pas par foyer, comme `user_profile`,
-- `hydration_day` et `weight_log`. Un rappel de pesee ou d'hydratation est une
-- affaire personnelle ; et meme un rappel de cuisine ("repas du soir") se regle
-- par personne : deux habitants d'une meme cuisine n'ont pas a recevoir la meme
-- chose a la meme heure. Aucune colonne de foyer, donc : le foyer se relit sur
-- le compte au moment d'envoyer, et ces tables n'entrent pas dans la liste de
-- `scripts/lib/tables-foyer.mjs`.
--
-- ON DELETE CASCADE partout : supprimer un compte emporte ses abonnements, sans
-- quoi ses appareils continueraient de recevoir les rappels d'un compte mort.
-- =============================================================================

-- Un appareil abonne. L'adresse (`endpoint`) est celle du service de
-- notification du fabricant (Apple, Google, Mozilla), propre a l'appareil et a
-- l'application. Elle est UNIQUE : un meme telephone qui change de compte change
-- de proprietaire, il ne recoit pas les rappels des deux.
CREATE TABLE push_subscription (
  id            INTEGER PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES user (id) ON DELETE CASCADE,
  endpoint      TEXT    NOT NULL UNIQUE,
  -- Cles de chiffrement fournies par l'appareil : le contenu d'une notification
  -- est chiffre pour lui seul, le service du fabricant ne le lit pas.
  p256dh        TEXT    NOT NULL,
  auth          TEXT    NOT NULL,
  created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  last_sent_at  TEXT,
  -- Echecs consecutifs. Un abonnement perime renvoie 404 ou 410 et se supprime
  -- aussitot ; ce compteur borne les autres echecs.
  failure_count INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX ix_push_subscription_user ON push_subscription (user_id);

-- Ce que la personne veut recevoir. Une ligne par type, absente tant qu'elle
-- n'a rien regle : l'absence vaut "desactive", jamais "active par defaut". Une
-- notification qu'on n'a pas demandee fait desactiver toutes les autres.
CREATE TABLE notification_pref (
  user_id INTEGER NOT NULL REFERENCES user (id) ON DELETE CASCADE,
  kind    TEXT    NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  -- Heures de Paris, "HH:MM", separees par des virgules (l'hydratation en a
  -- plusieurs). NULL : les heures par defaut du type.
  times   TEXT,
  PRIMARY KEY (user_id, kind)
);

-- Ce qui est deja parti. La planification tourne toutes les quelques minutes
-- et rattrape un passage manque : sans ce journal, un meme rappel partirait a
-- chaque passage de sa fenetre. `slot_key` dit lequel : le jour pour un rappel
-- quotidien, le jour et l'heure pour un rappel qui revient dans la journee.
CREATE TABLE notification_log (
  user_id  INTEGER NOT NULL REFERENCES user (id) ON DELETE CASCADE,
  kind     TEXT    NOT NULL,
  slot_key TEXT    NOT NULL,
  sent_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  PRIMARY KEY (user_id, kind, slot_key)
);
