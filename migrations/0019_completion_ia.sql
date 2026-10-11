-- =============================================================================
-- Completion des fiches par l'IA : rayon, poids cuit, mois de saison
-- (shared/src/completion.ts, worker/src/completion.ts).
--
-- `ai_completed_at` dit qu'une fiche a deja ete soumise au modele, qu'il ait
-- rempli quelque chose ou non. Sans elle, un yaourt (ni saison ni poids cuit,
-- a juste titre) resterait "a completer" pour toujours, et serait renvoye au
-- modele a chaque passage. NULL = jamais soumise.
--
-- Une colonne et non une table : elle suit la fiche, son foyer et sa
-- suppression sans rien ajouter a `scripts/lib/tables-foyer.mjs`.
-- =============================================================================

ALTER TABLE ingredient ADD COLUMN ai_completed_at TEXT;
