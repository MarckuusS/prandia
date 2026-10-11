-- =============================================================================
-- Deux index pour ne plus lire toute la cuisine a chaque requete.
--
-- Le 2026-10-11, le compte a depasse le quota gratuit de D1 : 5 millions de
-- lignes lues par jour. La liste des rayons en avait lu 7,2 millions a elle
-- seule (`wrangler d1 insights`) : pour compter les ingredients de chaque
-- rayon, SQLite prenait l'index (household_id, in_personal_library, name) et
-- parcourait les 4 231 fiches de la cuisine (catalogue CIQUAL compris), onze
-- fois, une par rayon. 46 596 lignes par appel, 155 appels, dont ceux que la
-- completion par l'IA ajoutait a chaque question.
--
-- Meme travers, a moindre echelle, pour la recherche d'un nom exact (doublon
-- a la creation) : 4 232 lignes pour en trouver une.
--
-- Avec la cuisine EN TETE de l'index, le compte d'un rayon ne lit que ses
-- propres fiches, et la recherche d'un nom une seule entree.
-- =============================================================================

CREATE INDEX IF NOT EXISTS ix_ingredient_household_category ON ingredient (household_id, category_l1);
CREATE INDEX IF NOT EXISTS ix_ingredient_household_name ON ingredient (household_id, name_normalized);
