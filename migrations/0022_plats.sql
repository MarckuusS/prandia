-- =============================================================================
-- Cuisiner une recette : le plat tel qu'on l'a VRAIMENT fait (2026-10-14).
--
-- Un repas du planning ne gardait que "recette X, N portions", et ses apports
-- se recalculaient sur la recette ACTUELLE : la retoucher reecrivait les
-- semaines passees. Et une recette se suit rarement a la lettre (une autre
-- marque, de la sauce tomate faute de pelees), un plat se cuisine souvent pour
-- deux et pour plusieurs jours.
--
-- Cuisiner cree donc un PLAT : une fiche maison (`ingredient`, source
-- 'manual', `source_ref` = 'plat:<id>') dont les apports pour 100 g sont
-- calcules une fois, a la cuisson, sur les vrais ingredients ; un lot au frigo
-- de son poids cuit ; et ces deux tables, qui gardent ce qu'on y a mis. On en
-- mange ensuite des parts ou des grammes, comme de n'importe quel aliment. La
-- recette, elle, ne bouge pas.
-- =============================================================================

CREATE TABLE preparation (
  id              INTEGER PRIMARY KEY,
  household_id    INTEGER NOT NULL REFERENCES household (id),
  -- La fiche du plat : ses apports pour 100 g, figes a la cuisson. Retirer la
  -- fiche retire le plat.
  ingredient_id   INTEGER NOT NULL UNIQUE REFERENCES ingredient (id) ON DELETE CASCADE,
  -- La recette d'origine, s'il y en a une. Supprimee, le plat reste : il a ete
  -- mange, ses apports ne dependent plus d'elle.
  recipe_id       INTEGER REFERENCES recipe (id) ON DELETE SET NULL,
  cooked_on       TEXT    NOT NULL CHECK (cooked_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  cooked_weight_g REAL    NOT NULL CHECK (cooked_weight_g > 0),
  -- En combien de parts il se partage ; NULL, il se mange en grammes.
  parts           REAL    CHECK (parts IS NULL OR parts > 0),
  created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
-- (foyer, jour) : les plats d'une cuisine, les plus recents d'abord.
CREATE INDEX ix_preparation_household ON preparation (household_id, cooked_on);

-- Ce qu'on a VRAIMENT mis dans le plat. Le nom est recopie : la fiche d'un
-- ingredient peut disparaitre, ce qu'on a cuisine ce jour-la ne change pas.
CREATE TABLE preparation_line (
  id             INTEGER PRIMARY KEY,
  preparation_id INTEGER NOT NULL REFERENCES preparation (id) ON DELETE CASCADE,
  ingredient_id  INTEGER REFERENCES ingredient (id) ON DELETE SET NULL,
  name           TEXT    NOT NULL,
  quantity_g     REAL    NOT NULL CHECK (quantity_g > 0),
  unit           TEXT,
  ordinal        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX ix_preparation_line ON preparation_line (preparation_id, ordinal);
