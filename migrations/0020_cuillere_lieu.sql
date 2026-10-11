-- =============================================================================
-- Deux memoires de plus sur la fiche d'un ingredient.
--
-- `spoon_weight_g` : le poids d'une cuillere a soupe de CE produit (farine 8 g,
-- huile 13, miel 21). NULL = 15 g, celui de l'eau, comme avant. Il ne corrige
-- que les cuilleres (shared/src/units.ts) ; une cuillere a cafe en vaut le
-- tiers.
--
-- `usual_storage` : la derniere place ou un lot de ce produit a ete range
-- (frigo, placard, congelateur). Apprise, jamais saisie : chaque rangement la
-- reecrit (worker/src/repos/pantry.ts), et l'onglet "A ranger" la propose.
-- Pas de CHECK : un CHECK ajoute par ALTER ne se verifie pas sur les lignes
-- existantes, et le code n'ecrit que les trois valeurs connues.
-- =============================================================================

ALTER TABLE ingredient ADD COLUMN spoon_weight_g REAL;
ALTER TABLE ingredient ADD COLUMN usual_storage TEXT;

-- Les lots deja ranges donnent tout de suite une premiere memoire : le plus
-- recemment range de chaque produit.
UPDATE ingredient
   SET usual_storage = (
         SELECT p.storage FROM pantry_stock p
          WHERE p.ingredient_id = ingredient.id
            AND p.household_id = ingredient.household_id
            AND p.storage IS NOT NULL
          ORDER BY p.storage_since DESC, p.id DESC
          LIMIT 1)
 WHERE EXISTS (
         SELECT 1 FROM pantry_stock p
          WHERE p.ingredient_id = ingredient.id
            AND p.household_id = ingredient.household_id
            AND p.storage IS NOT NULL);
