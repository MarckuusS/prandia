# Écarts entre la PWA web et l'app desktop QML

Audit du 2026-08-09, sur le dépôt à `a4bb268`.

**Méthode.** Les 319 fonctionnalités décrites dans les six inventaires `docs/parite/*.json`
(qui décrivent le desktop QML, lu dans son code) ont été confrontées une par une au code réel de
`web/`, `worker/` et `shared/`. Chaque domaine a été audité, puis un second passage a tenté de
**réfuter** chaque écart déclaré, pour éviter de redemander du travail déjà fait. Ce second passage
a annulé 2 écarts et en a trouvé 19 que le premier avait ratés.

**`etat-web.json` est périmé** et ne doit plus servir : il décrit le web au 2026-08-02 16:14, avant
la vague de commits qui a ajouté toutes les écritures. Ce fichier-ci le remplace.

---

## 1. Le chiffre

| Statut | Nombre | Part |
|---|---:|---:|
| Fait | 180 | 56 % |
| Partiel | 24 | 8 % |
| Absent | 77 | 24 % |
| Sans objet sur mobile | 38 | 12 % |
| **Total** | **319** | |

Plus **19 écarts** trouvés par la contre-expertise, hors inventaire ou mal classés au premier passage.

Par domaine :

| Domaine | Total | Fait | Partiel | Absent | Sans objet |
|---|---:|---:|---:|---:|---:|
| Courses | 36 | 32 | 1 | 0 | 3 |
| Calendrier | 50 | 37 | 4 | 3 | 6 |
| Frigo | 52 | 34 | 2 | 2 | 14 |
| Ingrédients | 64 | 42 | 9 | 9 | 4 |
| Recettes | 58 | 30 | 4 | 21 | 3 |
| Transverse | 59 | 4 | 4 | 43 | 8 |

Lecture : **les cinq écrans du quotidien sont portés**. Courses, Calendrier et Frigo dépassent 70 %
de parité, et le Frigo va au-delà du desktop sur plusieurs points. Ce qui manque n'est pas réparti :
c'est **le transverse et les chantiers entiers jamais commencés**.

---

## 2. Les huit blocs absents

77 absences sur 79 se rangent dans huit chantiers. Aucun n'est un oubli : ce sont des phases du
plan de portage jamais engagées, ou des arbitrages en suspens.

| # | Bloc | Écarts | Verrou | API existante |
|---|---|---:|---|---|
| B1 | Import de recette par URL | 14 | Portage du parseur de quantités françaises, JSON-LD | Aucune |
| B2 | Tickets de caisse (Intermarché) | 18 | `pdfplumber` est du Python ; scorer `token_set_ratio` à réécrire | Aucune |
| B3 | Lidl Plus | 7 | Arbitrage produit : les identifiants tiers en clair côté serveur | Aucune |
| B4 | Photos de recette | 4 | Le jeton wrangler n'a pas la portée `r2` | `imageKey` circule déjà |
| B5 | Sauvegarde, restauration, export | 7 | Aucune stratégie d'instantané D1 décidée | Aucune |
| B6 | Recherche unifiée | 6 | Aucun | Toutes les routes existent |
| B7 | "Qu'est-ce que je peux cuisiner" | 4 | Algorithme de couverture à porter | Aucune |
| B8 | Gestion des rayons | 4 | Pas de table `category_definition` en D1 | `GET /api/categories` (vue dérivée) |

**B6 est le plus rentable** : six écarts, aucun verrou technique, toutes les routes déjà servies.
Il ne manque que l'interface.

**B5 mérite d'être remonté malgré son rang.** Aujourd'hui les données du foyer vivent dans une seule
base D1, sans aucune copie que l'utilisateur maîtrise, et sans aucun export. Le desktop faisait une
sauvegarde à chaque lancement, avec rotation. Une fausse manoeuvre n'a pour filet qu'un toast de
six secondes.

---

## 3. Les régressions silencieuses

Ce sont les fonctionnalités classées "faites" qui ne se comportent pas comme le desktop, sans que
rien ne le dise. Elles comptent plus que les absences : une absence se voit, une régression non.

### 3.1 Le coût de la semaine est sous-estimé et annoncé comme complet

`web/src/screens/semaine/totals.ts:148`. Le compteur de repas sans prix ne s'incrémente que si le
coût de l'entrée **entière** est indéterminable. Le desktop comptait le nombre de **lignes** sans
prix à l'intérieur de chaque recette. Conséquence : une recette dont 2 ingrédients sur 5 n'ont pas
de prix affiche un coût partiel, avec "0 repas sans prix" et aucun avertissement. Le chiffre du
budget de la semaine est faux, et présenté comme sûr.

### 3.2 L'écran Frigo promet deux choses fausses

`web/src/screens/PantryScreen.tsx:101`. Le bandeau affirme que ce qui est rangé au frigo est
"retranché de ta liste de courses" et qu'un ingrédient couvert "y arrive coché". Ni l'un ni l'autre
n'est vrai depuis l'abandon du pré-cochage automatique : l'agrégation estampille `inPantryG` sans
rien retrancher, et la ligne arrive décochée avec un encart proposant de cocher. L'utilisateur lit
la promesse, ouvre la liste, voit tout décoché, et conclut que le frigo est ignoré.

### 3.3 Reprendre une semaine et appliquer un modèle écrasent au lieu d'ajouter

`worker/src/repos/calendar.ts:161` et `:263`. Les deux opérations vident la semaine cible avant
d'insérer. Le desktop **ajoutait toujours**, ce qui permettait de poser un modèle sur une semaine
déjà entamée ou de cumuler deux modèles. Le changement est assumé et confirmé à l'utilisateur, mais
l'ancien comportement n'est plus atteignable. C'est le seul changement de sémantique métier de
l'audit : il demandait un arbitrage, pas un correctif.

> **Arbitré le 2026-08-09 : le remplacement est conservé**, tel quel. Deux appuis de suite ne créent
> pas de doublons, et la confirmation prévient de la perte. Composer une semaine par ajouts
> successifs n'est plus un usage supporté. Ne pas rouvrir ce point aux prochains audits.

### 3.4 Deux appareils qui éditent la même recette : le dernier écrase l'autre en silence

L'enregistrement remplace intégralement lignes et tags, et l'éditeur ignore volontairement les mises
à jour du cache pendant la saisie. Aucun numéro de version, aucun ETag, aucun avertissement. Sur un
desktop mono-utilisateur c'était sans conséquence. Ici les recettes appartiennent à un foyer partagé
entre téléphone et bureau, **ce qui est la raison d'être du portage**.

### 3.5 Perte de précision au-delà du kilo

`shared/src/units.ts:104`. Le desktop affichait 2 décimales entre 1 et 10 kg : 1250 g donnait
"1,25 kg". Le web donne "1,3 kg", et 2450 g devient "2,5 kg". L'écart atteint 50 g sur une ligne,
ce qui se voit en boucherie et en fruits et légumes. La même fonction alimente la liste de courses,
le texte partagé et l'écran de session : l'écart se propage partout.

### 3.6 Le mode sombre ne sait plus revenir au suivi système

`web/src/lib/theme.ts:62`. Le bouton bascule entre `light` et `dark` seulement. Le troisième état
`system`, qui est celui du premier lancement, n'est plus atteignable une fois le bouton touché.
`setChoice` existe mais n'est exposé nulle part. Le suivi jour / nuit d'iOS est perdu définitivement.

### 3.7 Un tag créé ne peut plus être renommé ni supprimé

Le web a ajouté la création de tags, que le desktop n'avait pas, sans ajouter la correction. Une
faute de frappe ou une couleur mal choisie s'installe pour toujours dans la rangée de filtres. Les
routes `PUT` et `DELETE /api/tags/:id` existent pourtant déjà.

### 3.8 Un homonyme du catalogue CIQUAL bloque une création

Le contrôle de doublon porte sur toute la table du foyer, catalogue compris, alors que le desktop ne
comparait qu'aux ingrédients manuels. Créer un ingrédient nommé comme une ligne CIQUAL non importée
est refusé, en désignant une fiche que l'utilisateur ne voit nulle part dans sa liste. Le serveur
renvoie pourtant `existingId`, jamais lu par le formulaire.

### 3.9 L'ordre de saisie des lignes de recette est écrasé au premier enregistrement web

Le client envoie les lignes déjà triées par rayon, le serveur réattribue les ordinaux depuis la
position dans le tableau. L'ordre de saisie d'origine, qui servait de départage à l'intérieur d'un
rayon, disparaît. Une recette éditée sur le web ne retrouvera plus son ordre sur le desktop.

### 3.10 Latent : le plafond de 500 lignes de la bibliothèque

`worker/src/repos/ingredients.ts:123`. La route qui alimente l'écran Ingrédients ne rend jamais plus
de 500 lignes, la route n'accepte aucun paramètre, et tri, groupement et filtres sont ensuite
appliqués **côté client** sur ce lot. Aujourd'hui la bibliothèque personnelle compte 76 lignes :
rien ne se voit. Au-delà de 500, la liste sera tronquée sans le dire, le compteur mentira, et trier
par protéines décroissantes ne classera que la tranche alphabétique chargée. Le même plafond
s'applique au sélecteur d'ingrédient des recettes et du calendrier.

### 3.11 Divers, vérifiés

- `/` rend l'écran Courses, mais l'onglet actif est `/courses` : au lancement de la PWA installée,
  aucun onglet n'est en surbrillance.
- Le pré-cochage automatique depuis le frigo a été remplacé par un bouton "Cocher". Choix assumé et
  documenté, mais c'est un geste de plus chaque semaine.
- Retirer un lot du frigo et le raccourci "Tout" sont définitifs, sans annulation, alors que
  `Toast.showUndo` existe et sert déjà à l'écran Semaine. "Tout" supprime en un seul tap, sans
  confirmation, dans une grille de trois boutons identiques.

---

## 4. Le point de départ de cet audit : les anneaux de macros

**L'anneau de répartition des macros existe côté web.** Il est tracé en SVG dans
`web/src/screens/recettes/RecipeDerived.tsx:319`, monté dans la fiche recette en
`RecipeEditor.tsx:271`, avec le même dénominateur Atwater recalculé que le desktop, le même départ
à midi, le même état vide, et une légende permanente qui remplace le survol souris.

En revanche, **les autres représentations visuelles du desktop manquent toutes**, et c'est bien le
même angle mort : ce sont des éléments sans route d'API propre, donc invisibles dans un suivi par
endpoints.

| Visuel du desktop | État web |
|---|---|
| Anneau de macros de la recette | Présent |
| Graphique d'évolution du prix d'un ingrédient | **Absent**, seulement des cartes chronologiques |
| Mini-histogramme du coût hebdomadaire, avec moyenne | **Absent**, seulement une liste de chiffres |
| Vignette photo dans la liste des recettes | **Absent**, liste purement textuelle |
| Pictogrammes de nutriments du formulaire ingrédient | **Absent**, alors que le composant existe |
| Tableau 8 nutriments x 7 jours du calendrier | **Absent**, remplacé par 2 colonnes Jour / Semaine |
| Vue d'ensemble de la semaine, même sur grand écran | **Absent**, un seul jour, à toute largeur |

---

## 5. Ce que le web fait en plus du desktop

À porter au crédit du portage, et à ne pas casser en cherchant la parité :

- **La session de courses en magasin** (chariot, scan, correspondance avec la liste, validation en
  cinq étapes) n'a aucun équivalent desktop et n'entre dans aucune ligne d'inventaire.
- La **fiche de lot du frigo** comble un trou signalé par l'inventaire, avec ses raccourcis moins un
  quart, moins la moitié, tout.
- Le **scan de code-barres** au rangement et le **relevé du prix payé**.
- Le refus de supprimer un ingrédient utilisé par une recette (409 `in_use`), là où le desktop
  supprimait sans vérifier.
- La protection du doublon **au renommage**, pas seulement à la création.
- Le mode sombre à trois états, appliqué avant le premier rendu.
- Le repli `name_normalized LIKE` qui rattrape les ligatures que FTS5 rate.
- Une confirmation avant suppression de recette, là où le desktop offrait une annulation après coup.

---

## 6. Ce qui est classé sans objet

38 fonctionnalités sont spécifiques au desktop et n'ont pas à être portées : glisser-déposer à la
souris, onglets magnétiques pendant un glissement, survol, fenêtres système détachables, barre de
défilement Qt, dossier surveillé, `QSettings`, panneau latéral de pastilles.

**Deux nuances importantes**, relevées par la contre-expertise :

- Le panneau de pastilles du desktop est classé sans objet parce que le **geste** ne se porte pas.
  Mais l'inventaire en décrivait l'équivalent tactile, une action "Ajouter au frigo" et "Ajouter au
  calendrier" **directement dans la fiche d'un ingrédient**. Cet équivalent n'existe pas.
- Les raccourcis clavier ne sont pas sans objet : l'app web s'ouvre aussi dans un navigateur de
  bureau, et elle a déjà des commandes non découvrables (Ctrl+S dans l'éditeur, Échap dans les
  feuilles, pincement neutralisé) sans aucun écran qui les explique.

---

## Annexe A : liste complète des écarts

### B1 Import de recette par URL (14)

> Comblé le 2026-10-11 : écran `/recettes/importer`, entrée en tête de "Nouvelle recette". Lecture du bloc JSON-LD seul (pas de `recipe-scrapers`, sans équivalent en JavaScript), revue ligne à ligne avant création, photo relayée par le serveur puis réduite par le téléphone. Différences avec le bureau : la quantité d'une pièce est convertie (le bureau la prenait pour des grammes), le lien et le temps sont enregistrés, et il n'y a pas de création d'ingrédient manuel depuis la revue (la ligne s'ignore puis s'ajoute dans l'éditeur). Voir CLAUDE.md, "Importer une recette par lien".

- **Coller une URL et extraire la recette** [absent / bloquant / effort eleve / Recettes]  
  Impossible de coller l'adresse d'une recette pour en recuperer nom, portions, instructions et lignes d'ingredients. Toute recette trouvee en ligne doit etre ressaisie a la main, ligne par ligne, au pouce.
  API deja servie : Aucune. Le champ sourceUrl existe deja en base et est affiche par l'editeur quand il est renseigne (web/src/screens/recettes/RecipeEditor.tsx:276-283), mais rien ne le remplit.

- **Ouvrir le wizard d'import de recette par URL** [absent / gênant / effort eleve / Recettes]  
  Aucun point d'entree pour importer une recette depuis une page web. La barre de la liste ne propose que Nouvelle recette. C'est la fonctionnalite qui alimente le plus vite une bibliotheque, et elle manque entierement.
  API deja servie : Aucune.

- **Tableau d'association des lignes extraites** [absent / gênant / effort eleve / Recettes]  
  Aucun ecran ne permet de revoir ligne par ligne ce qui a ete extrait d'une page et de l'associer a la bibliotheque. C'est l'ecran le plus lourd du wizard et il n'a aucun equivalent.
  API deja servie : Aucune.

- **Corriger le nom d'ingredient extrait avec re-recherche automatique** [absent / gênant / effort eleve / Recettes]  
  Pas de resolution automatique d'un nom libre vers un ingredient de la bibliotheque, ni de re-recherche apres correction. Aucun equivalent du classement flou (correspondance exacte, puis recherche prefixe en bibliotheque, puis extension au catalogue).
  API deja servie : GET /api/ingredients?q= (worker/src/routes/ingredients.ts:24-27) fournit la recherche en bibliotheque personnelle, mais sans scoring ni classement de candidats.

- **Importer la recette (validations de commit)** [absent / gênant / effort eleve / Recettes]  
  Pas de validation ni de creation de recette depuis un import, donc aucune promotion automatique des ingredients choisis en bibliotheque personnelle.
  API deja servie : POST /api/recipes (worker/src/routes/recipes.ts:23-31) permettrait la creation finale, avec controle d'existence des ingredients (assertIngredientsExist, lignes 87-102). PUT /api/ingredients/:id/library assurerait la promotion.

- **Corriger le nom, les portions et voir la source a l'import** [absent / gênant / effort faible / Recettes]  
  Etape de revue inexistante puisque l'import n'existe pas.
  API deja servie : Aucune.

- **Ajuster quantite et unite d'une ligne importee** [absent / confort / effort faible / Recettes]  
  Pas de champ quantite dans un contexte d'import. Le composant reutilisable existe pourtant deja et se comporte comme celui du desktop.
  API deja servie : Aucune.

- **Creer un ingredient manuel a la volee pour une ligne** [absent / confort / effort faible / Recettes]  
  Pas de creation d'ingredient au fil de l'import. La route de creation existe et est utilisee ailleurs, il ne manque que le formulaire dans le contexte de l'import.
  API deja servie : POST /api/ingredients (worker/src/routes/ingredients.ts:29-57), avec detection de doublon par nom normalise et code 409 explicite.

- **Ecran de confirmation et bascule sur la recette importee** [absent / confort / effort faible / Recettes]  
  Pas d'ecran de confirmation d'import ni de bascule vers la recette creee.
  API deja servie : Aucune.

- **Parsing francais des quantites des lignes extraites** [absent / gênant / effort moyen / Recettes]  
  La logique qui decoupe une ligne comme 1 c. a soupe d'huile d'olive en quantite, unite et nom n'a pas ete portee : ni fractions, ni fractions mixtes, ni alias d'unites francais, ni suppression des articles de tete, ni prefixes de conditionnement.
  API deja servie : Aucune.

- **Choisir l'ingredient associe a une ligne importee** [absent / gênant / effort moyen / Recettes]  
  Pas de liste de candidats a choisir par ligne, puisque le wizard d'import n'existe pas.
  API deja servie : Aucune.

- **Menu d'actions par ligne importee (4 chemins de resolution)** [absent / gênant / effort moyen / Recettes]  
  Aucun menu par ligne (chercher dans le catalogue, chercher en bibliotheque, creer manuellement, ignorer la ligne), faute d'ecran d'import.
  API deja servie : Aucune.

- **Fenetre de recherche manuelle d'ingredient (3 onglets)** [absent / gênant / effort moyen / Recettes]  
  Pas de recherche d'ingredient a trois portees (bibliotheque, catalogue local, OpenFoodFacts en ligne) ouverte depuis une ligne d'import. Les briques cote API existent pourtant deja et sont utilisees ailleurs dans l'application.
  API deja servie : GET /api/ingredients?q= (routes/ingredients.ts:24), GET /api/catalog (routes/ingredients.ts:147), GET /api/off/search (routes/ingredients.ts:270) et PUT /api/ingredients/:id/library (routes/ingredients.ts:167) couvrent les trois onglets et la promotion en bibliotheque.

- **Telechargement automatique de la photo au commit d'un import** [absent / confort / effort moyen / Recettes]  
  Aucune recuperation de l'illustration de la page importee, ce qui suit logiquement de l'absence d'import et de socle photo.
  API deja servie : Aucune.

### B2 Tickets de caisse (24)

- **Analyse d un ticket PDF Intermarche** [absent / bloquant / effort eleve / Transverse]  
  Aucun parseur de ticket cote Worker. C est le verrou technique principal du domaine : pdfplumber est du Python et devra etre reecrit en JS ou isole dans un service dedie.

- **Rapprochement automatique des lignes avec les ingredients** [absent / bloquant / effort eleve / Transverse]  
  Aucun rapprochement de lignes de ticket, ni par source_ref, ni par alias appris, ni par similarite floue. Il n existe aucune table d alias exploitee cote web, donc aucun apprentissage d une session d import a l autre.

- **Enregistrement de l import et cascade de calcul de la quantite** [absent / bloquant / effort eleve / Transverse]  
  Aucun enregistrement de ticket. La cascade de determination de la quantite (saisie utilisateur, puis quantite de prix, puis poids unitaire fois quantite, puis 1000 g par defaut) n existe nulle part cote web. Un equivalent partiel a ete ecrit pour la session de courses en magasin, ce qui donne un modele mais pas la fonction.
  API deja servie : POST /api/ingredients/:id/prices (worker/src/routes/ingredients.ts:194), POST /api/pantry (worker/src/routes/pantry.ts:23), POST /api/courses/commit (worker/src/routes/courses.ts:197)

- **Selection manuelle d un fichier ticket** [absent / bloquant / effort faible / Transverse]  
  Aucun bouton d import de ticket nulle part, en particulier pas sur l ecran Frigo. Il n existe aucun champ de fichier dans l application web : l utilisateur ne peut faire entrer aucun ticket PDF.

- **Recherche d ingredient dans le selecteur (perimetre personnel ou catalogue)** [absent / bloquant / effort faible / Transverse]  
  Depend du selecteur de ligne de ticket, absent. La bascule bibliotheque / catalogue et l ajout automatique a la bibliotheque au moment du choix existent deja dans la feuille d import d ingredient.
  API deja servie : GET /api/catalog (worker/src/routes/ingredients.ts:147), PUT /api/ingredients/:id/library (worker/src/routes/ingredients.ts:167)

- **Choix de l ingredient d une ligne, suggestions du rapprochement** [absent / bloquant / effort moyen / Transverse]  
  Depend de l ecran de revision d un ticket, absent. Le selecteur d ingredient generique existe deja et pourrait accueillir les suggestions.
  API deja servie : GET /api/ingredients (worker/src/routes/ingredients.ts:24)

- **Creation d un ingredient depuis une ligne de ticket** [absent / bloquant / effort moyen / Transverse]  
  Depend du selecteur de ligne de ticket, absent. Le formulaire d ingredient complet existe deja ; ce qui manque vraiment, c est le pre-remplissage depuis la ligne et surtout l enregistrement de l alias enseigne + libelle qui fait tout l interet du mecanisme.
  API deja servie : POST /api/ingredients (worker/src/routes/ingredients.ts:29)

- **Alimentation automatique du frigo depuis un ticket de caisse** [absent / gênant / effort eleve / Frigo]  
  Le remplissage en masse du frigo existe cote web, mais par un autre chemin que le ticket : la session de courses en magasin cree un lot par article scanne au moment de valider le chariot. Trois morceaux du comportement desktop manquent. D abord il n y a aucun import de ticket deja paye, donc l utilisateur qui rentre de courses sans avoir scanne en magasin doit tout ressaisir a la main. Ensuite la DLC n est jamais demandee, la date de peremption est forcee a vide pour chaque lot cree, alors que le dialogue desktop offrait une colonne de dates ligne par ligne. Enfin la cascade de secours de quantite du desktop (quantite saisie, puis price_quantity_g, puis piece_weight_g multiplie par la quantite du ticket, puis 1000 g par defaut) n existe pas, la session exige une quantite article par article au scan.
  API deja servie : POST /api/courses/commit (worker/src/routes/courses.ts:197) pour le chemin session en magasin, et POST /api/pantry pour un lot unitaire. Aucune route d import de ticket.

- **Bouton Importer un ticket (PDF)** [absent / gênant / effort eleve / Frigo]  
  Aucun bouton, aucun ecran, aucune route d import de ticket de caisse cote web. De retour des courses avec un ticket papier ou un PDF, l utilisateur ne peut ni remplir son frigo ni alimenter son historique de prix en une seule operation. Le seul equivalent est d avoir pense a ouvrir une session de courses et a scanner chaque produit en magasin, ce qui suppose une decision prise avant les courses et non apres.

- **Messages d erreur sur format de ticket non reconnu** [absent / gênant / effort faible / Transverse]  
  Depend du parseur, absent. Les messages du desktop sont bons et sont a reprendre tels quels, en corrigeant l incoherence sur les fichiers html.

- **Detection de ticket deja importe et import force** [absent / gênant / effort faible / Transverse]  
  Aucune trace des tickets deja importes, donc aucun garde-fou contre un double comptage de l historique de prix.

- **Filtre Masquer les non-alimentaires (TVA B)** [absent / gênant / effort faible / Transverse]  
  Depend de l ecran de revision d un ticket, absent. L heuristique TVA A egale alimentaire n existe nulle part cote web.

- **Compteur N / M lignes mappees** [absent / confort / effort faible / Transverse]  
  Depend de l ecran de revision d un ticket, absent. A noter qu un compteur equivalent existe deja pour la session de courses et pourrait servir de modele.

- **Edition de la quantite reelle d une ligne** [absent / gênant / effort faible / Transverse]  
  Depend de l ecran de revision d un ticket, absent. Le composant de saisie de quantite conscient des pieces existe pourtant deja et serait reutilisable tel quel.

- **Correction manuelle du prix d une ligne** [absent / gênant / effort faible / Transverse]  
  Depend de l ecran de revision d un ticket, absent. La saisie de prix tolerante a la virgule existe deja ailleurs et serait reutilisable.

- **Saisie de la DLC d une ligne** [absent / gênant / effort faible / Transverse]  
  Depend de l ecran de revision d un ticket, absent. La saisie de DLC existe deja pour un lot de frigo et devra etre reprise, avec un champ date natif au lieu du champ texte tolerant du desktop.

- **Saisie d un code-barres et recherche OpenFoodFacts sur une ligne** [absent / gênant / effort faible / Transverse]  
  Depend de l ecran de revision d un ticket, absent. Toute la chaine existe pourtant deja par ailleurs : scanner camera, recherche par EAN et bascule en bibliotheque personnelle sont utilises dans l import d ingredient, le frigo et la session de courses.
  API deja servie : GET /api/off/barcode/:ean (worker/src/routes/ingredients.ts:297), PUT /api/ingredients/:id/library (worker/src/routes/ingredients.ts:167)

- **Recherche OpenFoodFacts en ligne depuis le selecteur** [absent / gênant / effort faible / Transverse]  
  Depend du selecteur de ligne de ticket, absent. La recherche OFF explicite avec bouton et etat de chargement existe deja dans la feuille d import d ingredient.
  API deja servie : GET /api/off/search (worker/src/routes/ingredients.ts:270)

- **Retirer une ligne de l import** [absent / gênant / effort faible / Transverse]  
  Depend de l ecran de revision d un ticket, absent. Le toast Annuler existe deja et devra cette fois etre branche, contrairement au desktop ou il ne l est pas.

- **Annuler l import en cours** [absent / gênant / effort faible / Transverse]  
  Depend de l ecran de revision d un ticket, absent. A prevoir avec la persistance du brouillon, comme cela a ete fait pour la session de courses, sinon quitter l app perdra le rapprochement manuel.

- **Etats vides et retours visuels du dialogue d import** [absent / confort / effort faible / Transverse]  
  Depend de l ecran de revision d un ticket, absent. Les composants d etat vide et de toast existent deja et respectent la zone sure basse.

- **Rattrapage des tickets deposes app fermee** [absent / gênant / effort moyen / Transverse]  
  Aucune file de tickets persistee cote serveur, donc rien a rattraper a l ouverture et aucun compteur de travail en attente.

- **Import d un ticket depuis le JSON de l API Lidl** [absent / confort / effort moyen / Transverse]  
  Aucun adaptateur Lidl cote Worker et aucune source de JSON Lidl, puisque l integration entiere est absente.

- **Point d entree automatique des tickets (partage vers l application)** [absent / gênant / effort moyen / Transverse]  
  Feature de l inventaire non listee. L auditeur a bien signale l absence de selection manuelle d un fichier, mais pas l absence du chemin d entree que l inventaire designe comme le remplacant naturel du dossier surveille : le manifeste PWA ne declare aucun share_target, donc un ticket PDF recu par mail ne peut pas etre partage vers l application installee. Combine a l absence totale de champ de fichier, il n existe aujourd hui aucune facon, ni automatique ni manuelle, de faire entrer un ticket.

### B3 Lidl Plus (9)

- **Bouton Lidl Plus a cinq etats** [absent / confort / effort eleve / Frigo]  
  Aucune integration Lidl Plus cote web. Pas de bouton dans l ecran Frigo, pas de reglage de connexion, pas de synchronisation des tickets. La source lidl existe pourtant deja comme valeur de badge dans le modele partage, mais rien ne produit jamais un ingredient de cette source.

- **Badge Lidl N tickets** [absent / confort / effort eleve / Transverse]  
  Aucune integration Lidl Plus cote web : pas de file de tickets synchronises, pas de badge, pas de recuperation de detail.

- **Enregistrement des identifiants Lidl Plus** [absent / confort / effort eleve / Transverse]  
  Aucun stockage d identifiants tiers cote serveur. La procedure du desktop passe par une commande en ligne de commande et le gestionnaire d identifiants Windows : elle n est pas transposable, il faudra soit un vrai flux d authentification dans l app, soit abandonner la fonctionnalite. C est le principal arbitrage produit du domaine.

- **Activation de la synchronisation automatique Lidl** [absent / confort / effort eleve / Transverse]  
  Aucun reglage de synchronisation. Un client web ne peut de toute facon pas tenir un minuteur en arriere-plan : il faudrait un declencheur planifie cote Worker, or aucun handler scheduled n est declare.

- **Synchronisation Lidl manuelle** [absent / confort / effort eleve / Transverse]  
  Aucun bouton de synchronisation Lidl, ni dans les reglages ni sur l ecran Frigo, et aucune ligne Derniere sync.

- **Purge des identifiants Lidl Plus** [absent / confort / effort faible / Transverse]  
  Depend du stockage d identifiants Lidl, absent. A prevoir avec une confirmation, contrairement au desktop, un bouton rouge etant facile a toucher par accident.

- **Reglage de l intervalle de synchronisation Lidl** [absent / confort / effort faible / Transverse]  
  Depend de la synchronisation automatique, absente. A remplacer par un choix simple plutot que par un champ numerique de 5 a 1440 minutes.

- **Libelle dynamique de l entree de menu Lidl Plus** [absent / confort / effort faible / Transverse]  
  Depend de l integration Lidl, absente. Se traduirait par une ligne de reglages avec sa valeur a droite, motif standard sur mobile.

- **Diagnostic d etat de l integration Lidl Plus** [absent / confort / effort moyen / Transverse]  
  Aucune notion de compte Lidl connecte cote web. Les deux premiers voyants du desktop (bibliotheque Python, keyring OS) n ont pas de sens ici, mais le troisieme, connecte ou non, en aurait un et n existe pas.

### B4 Photos de recette (5)

- **Liste des recettes (vignette + meta)** [partiel / confort / effort eleve / Recettes]  
  La liste rend le nom, les portions, le nombre d'ingredients, les tags, le temps de preparation et les cuissons recentes, mais aucune vignette photo ni placeholder a sa place. Le desktop montrait une image carree de 56 px a gauche de chaque ligne, ou l'emoji assiette a defaut. Visuellement la liste web est une liste de texte.
  API deja servie : GET /api/recipes renvoie deja imageKey (worker/src/repos/recipes.ts:165 et 216, worker/src/routes/recipes.ts:14-21) mais aucune route ne sert le fichier correspondant.

- **Affichage de la photo de recette** [absent / gênant / effort eleve / Recettes]  
  Aucune photo n'est affichee nulle part, ni dans la liste ni dans l'editeur. Le champ imageKey est lu et reexpedie tel quel a chaque enregistrement pour ne pas l'effacer, mais rien ne l'exploite.
  API deja servie : Aucune. Aucune route photo dans worker/src/routes (verifie sur les 8 fichiers de routes), aucun binding R2.

- **Ajouter ou remplacer la photo de recette** [absent / gênant / effort eleve / Recettes]  
  Impossible d'attacher une photo a une recette depuis le web. Aucun champ de fichier, aucun bouton, aucun acces a l'appareil photo. C'est pourtant l'usage le plus naturel en mobilite (photographier son plat).
  API deja servie : Aucune. Le schema d'ecriture accepte imageKey (utilise en web/src/screens/recettes/draft.ts:173) mais aucune route POST /api/recipes/:id/photo n'existe cote worker.

- **Retirer la photo de la recette** [absent / confort / effort faible / Recettes]  
  Sans affichage ni envoi de photo, il n'y a evidemment rien a retirer. A noter tout de meme : imageKey est reexpedie a chaque enregistrement, donc une photo posee par un autre client ne pourrait pas etre supprimee depuis le web.
  API deja servie : Aucune (pas de DELETE /api/recipes/:id/photo). PUT /api/recipes/:id accepte imageKey a null, ce qui suffirait cote base.

- **Deposer une image sur le cadre photo (fichier local ou URL web)** [absent / confort / effort moyen / Recettes]  
  Ni depot d'image, ni collage, ni champ pour coller l'URL d'une image trouvee sur le web. Le geste souris n'a pas de sens au doigt, mais son equivalent mobile propose par l'inventaire, un champ URL d'image, n'existe pas non plus.
  API deja servie : Aucune (pas de POST /api/recipes/:id/photo/from-url).

### B5 Sauvegarde et restauration (7)

- **Sauvegarde automatique de la base a chaque lancement** [absent / gênant / effort eleve / Transverse]  
  Aucun mecanisme d instantane cote serveur ni d export telechargeable. Le declencheur au lancement n a plus de sens avec plusieurs clients, mais aucun remplacement n existe : l utilisateur n a aujourd hui aucune copie de secours qu il maitrise.

- **Restauration d une sauvegarde** [absent / gênant / effort eleve / Transverse]  
  Impossible de revenir a un etat anterieur depuis l application. Une fausse manoeuvre destructive (vider une semaine, supprimer une recette et ses repas) n a aujourd hui aucun filet de securite autre que le toast Annuler de quelques secondes.

- **Messages d erreur de restauration** [absent / confort / effort faible / Transverse]  
  Depend de la restauration, absente. Les briques d affichage existent pourtant deja (toast et etats d erreur partages).

- **Etat vide de la liste de sauvegardes** [absent / confort / effort faible / Transverse]  
  Depend de la liste de sauvegardes, absente. Le texte devra de toute facon etre reecrit : la phrase du desktop parle du lancement de l application.

- **Rotation des sauvegardes (7 jours + 6 mois)** [absent / confort / effort moyen / Transverse]  
  Sans sauvegardes, aucune politique de retention. A prevoir en meme temps que la strategie d instantanes, sinon les exports s accumuleront.

- **Liste des sauvegardes disponibles** [absent / gênant / effort moyen / Transverse]  
  Aucun ecran ne liste de sauvegardes, avec ou sans date, taille et tri decroissant.

- **Export ou telechargement des donnees** [absent / gênant / effort moyen / Transverse]  
  Feature de l inventaire non listee, dont la transposition web est explicite : le bouton qui ouvrait l explorateur de fichiers doit devenir Telecharger cette sauvegarde. Or l application ne sait rien telecharger du tout : aucun createObjectURL, aucun attribut download, aucun Blob dans tout web/src. Le seul partage existant est un texte de liste de courses passe a navigator.share. Consequence concrete : meme si des instantanes serveur existaient, l utilisateur n aurait aucun moyen d en recuperer une copie sur son appareil, et il ne peut aujourd hui sortir aucune donnee de l application.

### B6 Recherche unifiee (8)

- **Recherche dans le planning (section Calendrier de la recherche unifiee)** [absent / confort / effort eleve / Calendrier]  
  Aucune recherche, ni globale ni limitee au planning. Rien ne permet de retrouver dans quelle semaine ou quel creneau une recette a ete planifiee, ni de repondre a "quand ai-je prevu le chili". La fonctionnalite etait deja cassee sur le desktop (la section restait toujours vide), mais l'inventaire recommandait de la reimplementer proprement et sur TOUTES les semaines, ce qui est justement l'usage utile en mobilite. Rien n'a ete fait.
  API deja servie : Aucune. GET /api/calendar/:week (worker/src/routes/calendar.ts:52) ne sert qu'une semaine a la fois : une recherche multi-semaines demande une nouvelle route cote worker en plus de l'interface.

- **Libelles et sous-libelles des resultats de recherche** [absent / confort / effort faible / Transverse]  
  Sans palette de recherche, il n y a ni icones de type, ni sous-libelle de source, ni mention de saison, ni jour et creneau pour une entree de calendrier.

- **Activation d un resultat (routage vers le bon onglet)** [absent / gênant / effort faible / Transverse]  
  Aucun resultat global a activer. Les routes cibles existent pourtant deja et corrigeraient au passage les deux defauts du desktop (ingredient non pre-selectionne, case de repas non surlignee).
  API deja servie : GET /api/ingredients/:id (worker/src/routes/ingredients.ts:59), GET /api/recipes/:id (worker/src/routes/recipes.ts:33), GET /api/calendar/:week (worker/src/routes/calendar.ts:52)

- **Etats vides de la recherche unifiee** [absent / confort / effort faible / Transverse]  
  Pas de palette, donc pas d invitation a taper ni de message Aucun resultat associe. Les composants d etat vide generiques existent mais ne sont pas branches sur une recherche globale.

- **Navigation clavier dans les resultats de la recherche unifiee** [absent / confort / effort faible / Transverse]  
  L auditeur a liste cinq des six features de la recherche unifiee et a oublie celle-ci. Elle est absente au meme titre que les autres, puisqu il n existe aucune palette : ni fleches haut et bas pour parcourir, ni Entree pour ouvrir, ni pied de page rappelant ces touches. A porter en meme temps que la palette, en corrigeant au passage le defaut connu du desktop, qui laisse selectionner un en-tete de section.

- **Recherche rapide de recette (section Recettes de la recherche unifiee)** [partiel / confort / effort moyen / Recettes]  
  Rechercher une recette par son nom fonctionne, mais uniquement depuis l'ecran Recettes. Il n'existe aucun point d'entree global permettant de chercher une recette depuis les onglets Semaine, Courses, Frigo ou Ingredients, alors que c'est la l'interet du raccourci desktop.
  API deja servie : GET /api/recipes?q= existe et fait un LIKE cote SQL (worker/src/routes/recipes.ts:14-21, worker/src/repos/recipes.ts:145-148).

- **Ouverture de la recherche unifiee** [absent / gênant / effort moyen / Transverse]  
  Il n existe aucune palette de recherche globale ni aucune icone loupe permanente dans l en-tete. Pour trouver quelque chose il faut d abord choisir le bon onglet, puis utiliser le champ de recherche local de cet ecran.

- **Recherche en 3 sections avec anti-rebond** [absent / gênant / effort moyen / Transverse]  
  Aucune recherche transverse ingredients + recettes + calendrier. Chaque ecran cherche dans son propre perimetre avec son propre champ, et le calendrier n a aucun champ de recherche du tout.
  API deja servie : GET /api/ingredients?q= (worker/src/routes/ingredients.ts:24), GET /api/recipes?q= (worker/src/routes/recipes.ts:14), GET /api/calendar/:week (worker/src/routes/calendar.ts:52)

### B7 Quoi cuisiner avec ce que j ai (5)

- **Trouve-moi des recettes avec ces ingredients** [absent / bloquant / effort eleve / Ingredients]  
  La fonction "qu'est-ce que je peux cuisiner avec ce que j'ai" n'existe nulle part cote web : ni bandeau de selection, ni ecran de resultats categorises (realisables / il manque N / top 5 des achats debloquants). Rien ne remplace ce parcours, c'est un usage entier qui reste sur le desktop.

- **Trouver les recettes realisables avec des ingredients donnes** [absent / gênant / effort eleve / Recettes]  
  Aucun ecran ne repond a la question de savoir ce qu'on peut cuisiner avec ce qu'on a. Ni les trois listes du desktop (realisables, a un ou deux ingredients pres, top des achats debloquants), ni un point d'entree depuis les ingredients ou le frigo. C'est pourtant l'usage mobile le plus evident du frigo deja porte.
  API deja servie : Aucune.

- **Dialogue Recettes possibles, trois sections** [absent / gênant / effort eleve / Transverse]  
  Rien cote web ne repond a la question qu est-ce que je peux cuisiner avec ce que j ai. Pas de section recettes entierement couvertes, pas de section il te manque peu avec les noms des ingredients manquants, pas de suggestions d achat classees par nombre de recettes debloquees. C est une perte fonctionnelle nette, d autant plus visible que l ecran Frigo connait deja le stock.
  API deja servie : GET /api/recipes (worker/src/routes/recipes.ts:14), GET /api/pantry (worker/src/routes/pantry.ts:21)

- **Cases a cocher de multi-selection dans la liste** [absent / gênant / effort faible / Ingredients]  
  Aucune case a cocher ni mode selection dans la liste de la bibliotheque. Une ligne n'est qu'un lien vers la fiche. Il n'existe donc aucun moyen de designer plusieurs ingredients a la fois, ni pour la recherche de recettes, ni pour une action groupee.

- **Interactions du dialogue Recettes possibles** [absent / confort / effort faible / Transverse]  
  Depend de l ecran precedent, absent. Au portage, rendre les cartes de recette cliquables, ce que le desktop ne fait pas : c est le premier reflexe attendu au doigt.
  API deja servie : GET /api/ingredients/:id (worker/src/routes/ingredients.ts:59)

### B8 Gestion des rayons (5)

- **Renommer un rayon (avec mise a jour en cascade)** [absent / gênant / effort eleve / Ingredients]  
  Aucun moyen de renommer un rayon. Corriger "Fruits et legumes" en "Fruits & legumes" oblige a ouvrir chaque fiche concernee et a retaper la valeur, avec le risque de laisser deux libelles voisins qui se comportent comme deux rayons distincts dans la liste de courses et le frigo.

- **Liste des categories d'une source de catalogue** [partiel / confort / effort faible / Ingredients]  
  La route existe et est bien consommee, mais elle ne sait pas filtrer par source. Elle rend en un seul paquet les groupes ANSES des lignes CIQUAL et les rayons supermarche saisis par l'utilisateur, alors que le desktop distinguait les deux. Consequence visible : le menu Categorie de l'onglet CIQUAL propose des rayons personnels qui ne correspondent a aucune ligne CIQUAL, et le menu Rayon du formulaire propose des groupes ANSES herites du seed.
  API deja servie : GET /api/categories (worker/src/routes/ingredients.ts:161)

- **Editeur de rayons d'ingredients (Parametres)** [absent / gênant / effort moyen / Ingredients]  
  L'ecran Parametres n'a pas de section Rayons. L'utilisateur ne peut pas consulter la liste de ses rayons, ni comprendre lesquels existent, ni les organiser. Les rayons ne sont plus une liste que l'on gere mais une valeur libre saisie fiche par fiche.
  API deja servie : GET /api/categories (worker/src/routes/ingredients.ts:161) rend les valeurs distinctes de category_l1 avec leur nombre d'ingredients, mais c'est une vue derivee en lecture seule, pas une table de rayons

- **Supprimer un rayon (avec effacement en cascade)** [absent / confort / effort moyen / Ingredients]  
  Aucun moyen de supprimer un rayon. Un rayon cree par erreur reste propose dans le menu du formulaire tant qu'au moins un ingredient le porte, et disparait sans prevenir quand le dernier ingredient change de rayon.

- **Ajouter un rayon** [partiel / confort / effort moyen / Ingredients]  
  On peut bien creer un rayon, mais uniquement en passant par la fiche d'un ingredient et l'option "Autre rayon" en saisie libre. Il n'y a ni ecran dedie, ni controle d'unicite, ni message d'erreur : taper "Viandes " avec une espace finale ou "viandes" en minuscules cree un second rayon voisin qui se comportera comme un rayon distinct dans la liste de courses et le frigo.
  API deja servie : PATCH /api/ingredients/:id accepte categoryL1 (worker/src/routes/ingredients.ts:65-93) : c'est ce qui fait exister le rayon, faute de table dediee

### Ecarts unitaires, par ecran (43)

#### Ingredients

- **Tri des resultats du catalogue CIQUAL** [absent / confort / effort faible]  
  L'onglet CIQUAL n'offre aucun choix de tri : les resultats arrivent toujours par nom croissant. Impossible de demander "les plus riches en proteines de ce rayon", qui est le principal usage du panneau de tri du desktop.

- **Reinitialiser les filtres du catalogue** [absent / confort / effort faible]  
  Aucun bouton de remise a zero dans l'onglet CIQUAL. Il faut vider le champ de recherche puis remettre la categorie sur "Toutes les categories" a la main, en deux gestes separes.

- **Tableau nutritionnel a 8 champs (ordre reglementaire UE)** [partiel / confort / effort faible]  
  Les 8 champs sont bien la, dans l'ordre reglementaire, avec les bonnes unites et les sous-lignes en retrait. Ce qui manque, ce sont les pictogrammes de nutriment qui accompagnent chaque libelle sur le desktop : le tableau du formulaire est purement textuel. Le composant qui les affiche existe pourtant deja cote web et sert ailleurs. Second ecart : les bornes hautes des 7 champs en grammes sont ramenees a 100 alors que le desktop acceptait jusqu'a 10000, et la valeur saisie est ramenee silencieusement a 100 a la sortie du champ.
  API deja servie : POST /api/ingredients et PATCH /api/ingredients/:id acceptent deja les 8 macros (worker/src/routes/ingredients.ts:29-93)

- **Autocompletion de l'enseigne** [partiel / confort / effort faible]  
  Le champ Enseigne propose bien des pastilles cliquables, mais uniquement les enseignes deja saisies POUR CET INGREDIENT. La premiere fois qu'un prix est releve sur une fiche, aucune suggestion n'apparait, alors que l'utilisateur a deja saisi Lidl et Auchan vingt fois ailleurs. Le desktop proposait la liste globale des enseignes.
  API deja servie : GET /api/stores (worker/src/routes/ingredients.ts:164) et le hook useStores (web/src/lib/queries.ts:892-896) existent deja et sont utilises par web/src/screens/courses/SessionBar.tsx:139

- **Detection de doublon de nom a la creation** [partiel / gênant / effort faible]  
  Le doublon est bien detecte et le message s'affiche sous le champ Nom, mais l'utilisateur reste bloque : il n'y a pas d'action "Ouvrir la fiche existante" alors que le serveur renvoie deja son identifiant. Aggravant : le controle porte sur toute la table du foyer, donc sur les milliers de lignes CIQUAL du catalogue qui ne sont PAS dans la bibliotheque personnelle. Creer a la main un ingredient nomme comme une entree CIQUAL non importee est refuse en designant une fiche que l'utilisateur ne voit nulle part dans sa liste.
  API deja servie : POST /api/ingredients renvoie deja 409 avec extra.existingId, expose par ApiError (web/src/lib/api.ts:18-32)

- **Pagination des resultats du catalogue** [partiel / gênant / effort faible]  
  Le nombre total de resultats est bien affiche, mais on ne peut jamais depasser les 50 premieres lignes : aucun bouton Precedent/Suivant, aucun Charger plus, aucun defilement infini. L'ecran se contente d'inviter a affiner la recherche. Un rayon CIQUAL de 300 entrees est donc inatteignable au-dela de la lettre C.
  API deja servie : GET /api/catalog accepte deja limit (max 200) et offset et renvoie totalCount, limit, offset (worker/src/routes/ingredients.ts:147-159)

- **Import groupe de plusieurs ingredients** [partiel / confort / effort faible]  
  La selection multiple fonctionne et survit bien aux changements d'onglet et de requete, l'import en lot aussi. Il manque l'action "Selectionner la page" du desktop : sur un resultat de 30 lignes il faut cocher les cases une par une.
  API deja servie : PUT /api/ingredients/:id/library (worker/src/routes/ingredients.ts:167-184), appele en boucle faute de route d'import groupe

- **Indicateur OpenFoodFacts indisponible** [partiel / confort / effort faible]  
  Rien ne previent avant la requete : le bouton "Chercher en ligne" reste actif meme telephone hors reseau ou service OFF en panne. L'utilisateur declenche, attend, puis lit un message d'echec. Le desktop grisait le bouton et affichait un avertissement grace a une sonde periodique.

- **Plafond silencieux de 500 lignes sur la bibliotheque personnelle** [absent / confort / effort faible]  _(trouve par la contre-expertise)_  
  La route qui alimente tout l ecran Ingredients ne rend jamais plus de 500 lignes, et rien ne le dit. Le desktop en chargeait 2000 hors recherche. Trois consequences invisibles : le compteur affiche en tete de liste annonce un total qui est en realite le nombre de lignes rendues, donc il ment ; le tri, le groupement et les filtres etant tous appliques cote client sur ce paquet, trier par proteines decroissant ne classe que les 500 premiers ingredients par ordre alphabetique, pas la bibliotheque ; et le meme plafond s applique au selecteur d ingredient des recettes et du calendrier, qui passe par le meme hook. Aucun message du type affine ta recherche, contrairement a l onglet CIQUAL qui, lui, previent quand il tronque.
  API deja servie : GET /api/ingredients (worker/src/routes/ingredients.ts:24) : le repo accepte deja un parametre limit, la route ne le lit simplement pas et ne renvoie pas de vrai total

- **Les chips de rayon des filtres sont calcules sur les resultats de la recherche en cours** [absent / confort / effort faible]  _(trouve par la contre-expertise)_  
  La section Rayon de la feuille Filtres n est pas alimentee par la liste des rayons du foyer mais par les ingredients actuellement charges, donc deja filtres par le champ de recherche. Chercher tomate puis ouvrir les filtres ne propose que les rayons des tomates, et la section disparait entierement si aucun resultat ne porte de rayon. Pire : un rayon deja actif via l URL et absent des resultats courants continue de filtrer sans qu aucune pastille ne permette de le desactiver. Le desktop rechargeait la liste complete des rayons a chaque ouverture du dialogue, independamment de la recherche.
  API deja servie : GET /api/categories (worker/src/routes/ingredients.ts:161) et le hook useCategories (web/src/lib/queries.ts:203-207), deja utilises par le menu Rayon du formulaire

- **Six plages min/max sur les macros** [absent / confort / effort moyen]  
  Impossible de filtrer la bibliotheque par bornes nutritionnelles (energie, lipides, glucides, fibres, proteines, sel). La feuille Filtres ne propose que Source, Rayon et les 4 bascules rapides. Un utilisateur qui cherche "tout ce qui depasse 20 g de proteines" doit trier par proteines et parcourir a l'oeil.

- **Graphique d'evolution du prix au 100 g** [absent / gênant / effort moyen]  
  La feuille Historique des prix n'affiche aucune courbe. L'utilisateur ne voit que des cartes chronologiques : il ne peut plus lire d'un coup d'oeil si le prix monte, descend ou oscille selon l'enseigne, ni reperer la ligne de moyenne. C'est la representation visuelle la plus visible du domaine qui manque.
  API deja servie : GET /api/ingredients/:id/prices (worker/src/routes/ingredients.ts:190-192) rend deja toutes les observations avec priceEur et quantityG ; le prix au 100 g se recalcule cote client avec pricePerG, deja utilise en PriceHistorySheet.tsx:195-198

- **Panneau de filtres du catalogue CIQUAL** [partiel / gênant / effort moyen]  
  Seul le filtre par categorie est porte. Les quatre plages min/max (energie, proteines, glucides, lipides) ont disparu, alors que c'est ce qui rend le catalogue de 3000 entrees exploitable. Autre defaut visible : le menu Categorie liste TOUTES les valeurs de category_l1 du foyer, donc les rayons supermarche crees par l'utilisateur melanges aux groupes ANSES, et non les seules categories des lignes CIQUAL. Choisir un rayon personnel dans l'onglet CIQUAL donne donc souvent zero resultat.
  API deja servie : GET /api/catalog?source=&category=&limit=&offset= (worker/src/routes/ingredients.ts:147-159) : la categorie est deja servie, les bornes macro sont a ajouter cote SQL

- **Tri, groupement et filtres non conserves entre deux ouvertures de l application** [absent / confort / effort moyen]  _(trouve par la contre-expertise)_  
  Les options de vue vivent exclusivement dans la query string. Elles survivent donc a un rafraichissement et au bouton Retour, ce qui est un gain, mais elles sont perdues des que l utilisateur quitte l ecran par la barre d onglets ou rouvre la PWA : on retombe systematiquement sur tri par nom croissant, aucun groupement, aucun filtre. Le desktop restaurait l etat complet via QSettings. Quelqu un qui travaille toujours groupe par rayon doit le reregler a chaque session.

#### Recettes

- **Filtrer la liste par tags (chips toggle)** [partiel / confort / effort faible]  
  Un seul tag peut etre actif a la fois : cliquer un second tag remplace le premier au lieu de cumuler. Le desktop retenait toute recette portant AU MOINS UN des tags actifs (OU logique). L'utilisateur qui veut voir les recettes vegetariennes OU rapides doit faire deux passages.
  API deja servie : GET /api/recipes?tag=<id> existe (worker/src/routes/recipes.ts:14-21, worker/src/repos/recipes.ts:149-154) mais n'accepte qu'un identifiant unique.

- **Confirmation des modifications non sauvees** [partiel / gênant / effort faible]  
  L'etat modifie est bien detecte et affiche en permanence dans une barre basse avec Abandonner et Enregistrer, mais AUCUNE navigation interne n'est interceptee : le bouton retour du telephone, le clic sur le nom d'un ingredient de ligne et le changement d'onglet quittent l'editeur et perdent le tampon sans le moindre avertissement. Seule la fermeture de l'onglet du navigateur declenche un avertissement, celui du navigateur.
  API deja servie : PUT /api/recipes/:id (worker/src/routes/recipes.ts:39-57) : le manque est purement cote interface.

- **Aucune confirmation visible apres J'ai cuisine ca** [absent / confort / effort faible]  _(trouve par la contre-expertise)_  
  Le desktop affichait un bandeau vert Cuisinee aujourd'hui, bon appetit pendant 3 s apres le clic rapide du journal de cuisson. Cote web, le bouton declenche la mutation sans le moindre retour explicite : le seul signe est la reecriture silencieuse de la phrase du bandeau, que l'utilisateur ne regarde pas puisqu'il vient d'appuyer sur le bouton juste en dessous. Sur un reseau lent le libelle passe bien par Enregistrement, mais rien ne dit que c'est parti. C'est d'autant plus incoherent que tout le reste de l'application a ete cable sur le meme systeme de toasts.
  API deja servie : Aucune route en cause : POST /api/recipes/:id/cooking existe et fonctionne (worker/src/routes/recipes.ts:112-134). Le manque est purement dans l'interface, et le composant Toast expose deja show (web/src/components/Toast.tsx:82-91).

- **Un tag cree depuis une recette ne peut plus etre renomme ni supprime** [absent / gênant / effort faible]  _(trouve par la contre-expertise)_  
  Le web ajoute la creation de tags, que le desktop n'avait pas, mais sans la contrepartie. Une faute de frappe dans le nom, ou une couleur mal choisie, s'installe definitivement : la pastille reste dans la rangee de filtres de l'ecran Recettes pour toujours. On peut seulement la detacher recette par recette, jamais la retirer du catalogue. Le desktop avait un catalogue en lecture seule, donc le probleme n'existait pas ; en ouvrant la creation sans ouvrir la correction, le web cree une impasse nouvelle.
  API deja servie : PUT /api/tags/:id et DELETE /api/tags/:id existent deja (worker/src/routes/recipes.ts:164-175), avec les hooks TanStack Query correspondants deja ecrits (web/src/lib/queries.ts:520-540). C'est le cas type de la route complete sans fonctionnalite utilisateur : il ne manque qu'un bouton dans la feuille Tags.

- **Annuler la suppression (UndoToast)** [absent / confort / effort moyen]  
  Aucune annulation apres suppression d'une recette. Le web a remplace l'annulation par une confirmation prealable, ce qui protege du geste maladroit, mais une recette confirmee par erreur est definitivement perdue avec son journal de cuisson et ses repas planifies.
  API deja servie : DELETE /api/recipes/:id (worker/src/routes/recipes.ts:59-78). Aucune route de restauration ; POST /api/recipes permettrait une recreation depuis un instantane conserve cote client.

- **Deux appareils qui editent la meme recette : le dernier ecrase l'autre sans un mot** [absent / gênant / effort moyen]  _(trouve par la contre-expertise)_  
  L'enregistrement remplace integralement les lignes et les tags de la recette, et l'editeur ignore volontairement les mises a jour du cache pendant la saisie. Sur le desktop mono-utilisateur cela ne coutait rien. Ici les recettes appartiennent a un foyer partage entre telephone et bureau, qui est la raison d'etre du portage : ouvrir la recette sur le telephone le matin, enregistrer le soir, efface en silence tout ce qui a ete ajoute depuis le bureau entre-temps. Aucun numero de version, aucun ETag, aucun avertissement.
  API deja servie : PUT /api/recipes/:id (worker/src/routes/recipes.ts:39-57) : la recette lue avant ecriture porte deja updatedAt (worker/src/rows.ts:93), il suffirait de le renvoyer dans la charge utile et de refuser en 409 si la valeur a bouge.

#### Calendrier

- **Tableau "Apports nutritionnels par jour"** [partiel / confort / effort faible]  
  Le web n'affiche que deux colonnes de valeurs, "Jour" (le jour selectionne dans la bande du haut) et "Semaine". Le tableau 8 nutriments x 7 jours du desktop, qui permettait de comparer lundi a dimanche d'un coup d'oeil et de reperer la journee trop grasse ou trop pauvre en fibres, n'existe pas : il faut changer de jour et memoriser les chiffres. Le titre ne rappelle pas non plus le total kcal de la semaine, contrairement au desktop.
  API deja servie : GET /api/calendar/:week (worker/src/routes/calendar.ts:52) rend deja toutes les entrees de la semaine plus les recettes et ingredients references (loadWeek, lignes 24-38). Les totaux par jour se calculent deja cote client, il ne manque que l'affichage des 7 colonnes.

- **Regles de calcul du cout hebdomadaire** [partiel / gênant / effort faible]  
  Le compteur de repas sans prix ne compte plus la meme chose et fait disparaitre l'avertissement dans le cas le plus courant. Le desktop incrementait le compteur du NOMBRE DE LIGNES sans prix de chaque recette ; le web n'incremente que si le cout de l'entree entiere est indeterminable. Une recette dont 2 ingredients sur 5 n'ont pas de prix affiche donc un cout partiel presente comme complet, avec "0 repas sans prix" et aucun bandeau d'alerte. L'utilisateur croit connaitre le cout de sa semaine alors qu'il est sous-estime.
  API deja servie : Aucune route de cout dediee cote worker : tout le chiffrage de la semaine est calcule cote client a partir de GET /api/calendar/:week. La correction est donc entierement dans totals.ts.

- **Archivage du cout de la semaine** [partiel / confort / effort faible]  
  L'archivage existe mais il est ailleurs, manuel, et il n'archive pas le meme montant. Depuis l'ecran Semaine, rien n'archive quoi que ce soit : il faut passer par l'onglet Courses puis appuyer sur "Archiver ce cout". Surtout, le montant enregistre est celui de la LISTE DE COURSES (agregee par ingredient, diminuee du stock du frigo), pas le cout du planning affiche dans la carte "Cout" de l'ecran Semaine. Les deux chiffres different, si bien que l'historique ne correspond pas a ce que l'ecran Semaine annonce.
  API deja servie : POST /api/shopping/:week/snapshot (worker/src/routes/shopping.ts:97) et repos.settings.saveWeeklyCost (worker/src/repos/settings.ts:121-151).

- **Sauter a une semaine depuis l'historique des couts** [absent / confort / effort faible]  
  Impossible de rejoindre une semaine depuis l'historique. Les lignes de la feuille "Cout des semaines" sont inertes : apres avoir repere la semaine la plus chere, l'utilisateur doit fermer la feuille, revenir a l'onglet Semaine et cliquer la fleche autant de fois qu'il faut pour l'atteindre.
  API deja servie : Aucune route necessaire : changer de semaine se fait par le parametre d'URL ?semaine=, deja gere par web/src/lib/useIsoWeekParam.ts:42-56 et lu par l'ecran Semaine.

- **Mini-histogramme "Evolution sur N semaines"** [partiel / confort / effort moyen]  
  L'historique des couts existe sous forme de liste dans l'ecran Courses, avec l'ecart chiffre par rapport a la semaine precedente, mais la representation graphique du desktop n'a pas ete portee : pas de barres, pas de barre mise en evidence pour la semaine consultee, pas de ligne "Moyenne : X,XX EUR", et rien du tout dans l'ecran Semaine ou le desktop l'affichait sous la grille. La question "est-ce que je depense plus qu'avant" redevient une lecture de chiffres alignes au lieu d'une forme reconnaissable en une seconde. C'est le meme angle mort que l'anneau de macros signale par l'utilisateur : une representation visuelle sans route d'API propre, donc facile a oublier.
  API deja servie : GET /api/shopping-history?limit=26 (worker/src/routes/shopping.ts:107-109), deja consomme par useShoppingHistory (web/src/lib/queries.ts:783-787). Les donnees sont la, il ne manque que le dessin.

- **Pastilles d'ingredients d'ajout rapide** [absent / confort / effort moyen]  
  Aucun raccourci d'ajout rapide d'ingredient. Le desktop offrait une palette de pastilles de la bibliotheque personnelle, avec la couleur de source et le badge "1 pc" quand un poids unitaire est defini. Sur le web, ajouter une pomme au gouter impose systematiquement le parcours complet : bouton Ajouter du creneau, bascule sur l'onglet Ingredient, saisie dans le champ de recherche, selection, validation. L'inventaire prevoyait explicitement de conserver ces pastilles comme raccourcis tappables et de n'abandonner que le geste de glisser.
  API deja servie : GET /api/ingredients (worker/src/routes/ingredients.ts:25, deja restreint a la bibliotheque personnelle via listPersonal) et POST /api/calendar/:week/entries (worker/src/routes/calendar.ts:54). La regle de quantite par defaut, 1 piece ou 100 g, est deja codee en web/src/screens/semaine/AddEntrySheet.tsx:40 et 141.

- **Aucune vue d'ensemble de la semaine, a aucune largeur d'ecran** [absent / gênant / effort moyen]  _(trouve par la contre-expertise)_  
  L'ecran Semaine ne montre qu'UN jour a la fois, et rien ne remplace la vue d'ensemble que donnait la grille 7 jours x 5 creneaux du desktop. La bande du haut ne porte qu'une initiale, un quantieme et une pastille de 4 px : elle dit qu'un jour contient quelque chose, jamais quoi ni combien. Pour savoir ce qui est prevu jeudi pendant qu'on regarde lundi, il faut changer d'onglet de jour et memoriser. Sur telephone c'est le bon choix et l'inventaire le recommandait, mais il demandait aussi de conserver la vue semaine en paysage et sur tablette : ce repli n'existe pas, le fichier de style de l'ecran ne comporte aucune regle de largeur alors que les ecrans Recettes, Ingredients, Frigo et Session en ont tous une. Ouverte dans un navigateur de bureau, la page reste une colonne d'un seul jour.
  API deja servie : Aucune route a creer : GET /api/calendar/:week (worker/src/routes/calendar.ts:52) rend deja les sept jours en une seule reponse, et le regroupement par jour existe cote client dans web/src/screens/semaine/totals.ts:159-163. Tout le manque est dans la mise en page.

- **Reprendre une semaine et appliquer un modele ecrasent la semaine, sans mode ajout** [absent / gênant / effort moyen]  _(trouve par la contre-expertise)_  
  Le desktop ajoutait toujours, jamais ne remplacait : on pouvait poser un modele sur une semaine deja entamee, ou cumuler deux modeles. Le web fait l'inverse, et seulement l'inverse : les deux operations suppriment d'abord toutes les entrees de la semaine cible. Consequence concrete : l'utilisateur qui a deja cale le samedi soir et applique ensuite son modele de menus perd le samedi soir, et il n'existe aucun moyen d'obtenir l'ancien comportement. Le risque est signale par une confirmation, donc la perte n'est pas silencieuse, mais la capacite de composer une semaine par ajouts successifs a disparu. Ce n'est pas un detail d'implementation serveur : c'est le sens des deux boutons les plus rentables de l'ecran en mobilite.
  API deja servie : POST /api/calendar/:week/copy-from (worker/src/routes/calendar.ts:194) et PUT /api/templates/:id/apply (worker/src/routes/calendar.ts:229) existent deja : il manque un parametre de mode, ajouter ou remplacer, et le choix correspondant dans les deux feuilles de WeekTools.

#### Courses

- **Pre-cochage automatique depuis le stock du Frigo / Cellier** [partiel / confort / effort faible]  
  Le desktop arrive avec les lignes deja cochees quand le frigo couvre le besoin. Le web ne coche plus rien tout seul : il affiche un encart "N articles sont deja au frigo en quantite suffisante" avec un bouton Cocher, et une pastille "deja 500 g au frigo" sur la ligne. L'utilisateur doit donc faire un geste de plus a chaque semaine pour retrouver l'etat de depart du desktop. La divergence est assumee et documentee dans le code (une case cochee que l'on n'a pas cochee soi-meme se lit comme une erreur sur telephone), et le remplacement est plus explicite, mais l'automatisme lui-meme n'existe plus.
  API deja servie : GET /api/shopping/:week renvoie deja inPantryG et isCoveredByPantry par ligne (worker/src/routes/shopping.ts:44-53, shared/src/shopping.ts:90-101). PUT /api/shopping/:week/checked persiste les coches (worker/src/routes/shopping.ts:59-89).

- **Impossible d aligner la liste sur la semaine que l on vient de planifier** [absent / confort / effort faible]  _(trouve par la contre-expertise)_  
  Le desktop avait un bouton "Synchroniser avec calendrier" qui recopiait en un clic la semaine affichee dans le Calendrier (feature bouton-synchroniser-avec-calendrier, priorite important). Cote web, la fonction de rechargement a bien ete portee (bouton Actualiser + invalidation de cache), mais la fonction de SAUT a disparu : l onglet Courses pointe vers /courses sans parametre, donc il ouvre toujours la semaine courante, et le seul moyen d atteindre une autre semaine est la fleche du WeekPicker, qui avance d une semaine par tap. Planifier 2026-W36 depuis l onglet Semaine puis vouloir la liste correspondante demande autant de taps que de semaines d ecart. Aucun lien inverse n existe : /semaine ne propose nulle part "voir la liste de cette semaine", alors que l ecran Frigo, lui, a bien un lien vers /courses.
  API deja servie : GET /api/shopping/:week accepte deja n importe quelle semaine (worker/src/routes/shopping.ts:44-53) et useIsoWeekParam lit deja ?semaine= : il suffit d un lien porteur du parametre depuis l ecran Semaine.

- **Perte d une decimale sur les quantites au-dela du kilo** [absent / confort / effort faible]  _(trouve par la contre-expertise)_  
  La feature ligne-format-quantite fixe la regle du desktop : au-dela de 1000 g on affiche des kg avec 2 decimales tant qu on est sous 10 kg (1,25 kg), 1 decimale au-dela. Le web passe par formatGrams, qui donne 0 decimale si la valeur est entiere, 0 si elle depasse 100, et 1 sinon : 1250 g s affiche donc 1,3 kg au lieu de 1,25 kg, et 2450 g devient 2,5 kg. L arrondi peut atteindre 50 g sur une ligne, ce qui se voit en boucherie ou en fruits et legumes. Divergence en sens inverse sous 100 g (le web est plus precis que le desktop), mais c est la perte au kilo qui compte en rayon. La meme fonction alimente le texte partage et l ecran de session, donc l ecart se propage partout.
  API deja servie : Aucune API en cause : quantityG brut est deja transmis, tout se joue dans le formatage client.

- **L ecran Frigo promet un pre-cochage et une soustraction qui n existent pas** [absent / gênant / effort faible]  _(trouve par la contre-expertise)_  
  Le bandeau permanent de l onglet Frigo affirme deux choses fausses depuis l abandon du pre-cochage : que le stock est retranche de la liste de courses (l agregation ne retranche rien, elle se contente d estampiller inPantryG et isCoveredByPantry) et qu un ingredient couvert par le frigo arrive coche sur la liste (il arrive decoche, avec un encart proposant de cocher). L utilisateur qui range ses courses lit une promesse, puis ouvre la liste et voit tout decoche : il conclut que le frigo n a pas ete pris en compte. C est l ecart de pre-cochage releve par l auditeur, mais aggrave par un texte qui le contredit, et ce texte-la n a ete releve nulle part.
  API deja servie : Rien a ajouter cote API : soit on reformule le bandeau, soit on implemente reellement le pre-cochage annonce.

#### Frigo

- **Aucune annulation apres retrait ou consommation totale d'un lot** [absent / gênant / effort faible]  _(trouve par la contre-expertise)_  
  Le retrait d'un lot et le raccourci Tout sont definitifs et silencieux : le message de confirmation qui suit est purement informatif, sans bouton Annuler. Le raccourci Tout est particulierement expose puisqu'il supprime le lot en un seul tap, sans aucune confirmation, dans une grille de trois boutons de meme apparence ou il occupe la troisieme case. Un faux contact en cuisine, une main mouillee, et le lot disparait sans recours. Le projet dispose pourtant deja du mecanisme : le composant Toast expose showUndo et l'ecran Semaine s'en sert exactement pour ce cas. Le desktop n'avait pas d'annulation non plus, mais l'inventaire designe explicitement ce manque comme a corriger au portage, et la brique est deja ecrite.
  API deja servie : POST /api/pantry (worker/src/routes/pantry.ts:23) permet de recreer le lot a l'identique, et le hook useAddStock existe deja (web/src/lib/queries.ts:690). Le rappel ne coute qu'un appel deja disponible.

- **Impossible d'ajouter au frigo depuis la bibliotheque d'ingredients** [absent / confort / effort faible]  _(trouve par la contre-expertise)_  
  Le seul point d'entree pour ranger quelque chose au frigo est le bouton flottant de l'ecran Frigo. Depuis la fiche d'un ingredient, rien ne permet de dire j'en ai achete : il faut memoriser le nom, aller sur l'onglet Frigo, ouvrir la feuille, et le rechercher une seconde fois. Le desktop offrait trois chemins depuis la bibliotheque (panneau lateral de chips, glisser-deposer sur la liste, onglets magnetiques pendant le glissement) qui evitaient toute navigation et toute nouvelle recherche. L'auditeur a range tout ce bloc en implicite sans objet parce que le geste souris ne se porte pas, mais l'inventaire ne dit pas de l'abandonner : il en decrit l'equivalent tactile, une action Ajouter au frigo directement dans la fiche d'un ingredient. Cet equivalent n'a pas ete implemente.
  API deja servie : POST /api/pantry (worker/src/routes/pantry.ts:23) et le hook useAddStock existent, la feuille AddStockSheet est deja ecrite et sait recevoir un ingredient pre-choisi via son etat interne (web/src/screens/frigo/AddStockSheet.tsx:81-84). Il ne manque que le point d'entree et le passage de l'ingredient en propriete.

- **Requete des peremptions imminentes (disponible, non exploitee)** [absent / confort / effort moyen]  
  Rien n avertit l utilisateur d une peremption imminente en dehors de l ecran Frigo lui-meme. Pas de route de peremptions, pas de pastille de compteur sur l onglet Frigo de la barre du bas, pas de notification Web Push, pas de tache planifiee. Le seul signalement reste le compteur textuel en haut de la page, visible uniquement quand on y est deja. Le desktop ne fait pas mieux, la methode expiring_before n y est appelee par personne, donc ce n est pas une regression, mais c est precisement la fonctionnalite que le passage en PWA rendait possible et elle n a pas ete saisie.
  API deja servie : Aucune route dediee, mais GET /api/pantry renvoie deja expiryDate pour chaque lot et le calcul des jours restants est deja ecrit cote client (web/src/screens/frigo/lots.ts:89 et shared/src/models.ts:472-477), donc une route de peremptions serait une simple projection

- **Les lots d'un meme ingredient restent disperses, le badge du nombre de lots est inerte** [absent / confort / effort moyen]  _(trouve par la contre-expertise)_  
  Quand un ingredient a plusieurs lots, chaque ligne affiche une pastille N lots avec le total cumule, mais cette pastille ne fait rien et rien ne permet de voir ces lots ensemble. Avec le tri par urgence, qui est le defaut, deux pots de yaourt aux peremptions eloignees tombent dans deux sections differentes de la liste : impossible de repondre a la question combien m'en reste-t-il et lequel dois-je entamer sans faire defiler tout l'ecran ou taper le nom dans le filtre. Le regroupement disponible ne porte que sur l'urgence ou le rayon, jamais sur l'ingredient. L'inventaire designait pourtant ce regroupement visuel comme l'amelioration la plus rentable du portage, precisement parce que des lots disperses sont illisibles sur un ecran etroit. La pastille informe du probleme sans donner le moyen de le resoudre.
  API deja servie : Aucune route a ajouter : GET /api/pantry (worker/src/routes/pantry.ts:21) renvoie deja tous les lots et le calcul est entierement client. Un quatrieme choix de groupement dans lots.ts et un depliage de carte suffisent.

#### Transverse

- **Menu Fichier** [partiel / confort / effort faible]  
  Un ecran Parametres existe et joue le role de destination pour ces entrees, mais aucune des trois entrees utiles du menu Fichier n y figure : ni Restaurer une sauvegarde, ni Lidl Plus, ni l editeur de rayons d ingredients. La page ne propose que le compte, l etat du serveur, la version et les mesures d affichage.

- **Indicateur de disponibilite OpenFoodFacts** [partiel / confort / effort faible]  
  Il n y a aucun voyant permanent dans la coquille de l app. L information de connectivite existe mais est enfouie dans Parametres (une ligne navigator.onLine et une verification de /api/health, qui teste l API du projet et non OpenFoodFacts). Consequence concrete : le bouton Chercher en ligne de la feuille d import n est jamais grise quand OFF est injoignable, alors que le desktop le grisait, et l utilisateur decouvre la panne par un echec de recherche.
  API deja servie : GET /api/health (worker/src/routes/system.ts:9)

- **Navigation clavier entre onglets (Ctrl+1 a Ctrl+5)** [absent / confort / effort faible]  _(trouve par la contre-expertise)_  
  Feature de l inventaire absente de la liste de l auditeur. La coquille web n installe aucun ecouteur clavier : passer d un onglet a l autre exige de viser la barre basse. Les seuls raccourcis du web sont Ctrl ou Cmd + S dans l editeur de recette et Echap dans les feuilles. L inventaire refuse de classer ces raccourcis sans objet, parce que l app web est aussi ouverte depuis un navigateur de bureau, ou une barre d onglets basse est un mauvais substitut a une touche.

- **Reference des raccourcis et des gestes** [absent / confort / effort faible]  _(trouve par la contre-expertise)_  
  Feature de l inventaire non listee. Il n existe aucun ecran d aide cote web, alors que l app web a deja des commandes non decouvrables : Ctrl ou Cmd + S enregistre une recette, Echap ferme une feuille, et le pincement est neutralise sans que rien ne l explique. L inventaire propose de remplacer la fenetre desktop par une page d aide gestuelle sur mobile ; ni l une ni l autre n existe.

- **Barre de 5 onglets avec conservation d etat** [partiel / gênant / effort moyen]  
  Les 5 onglets existent, dans le meme ordre et avec des libelles adaptes. En revanche l etat n est pas conserve : revenir sur un onglet via la barre remet l ecran a zero. Le lien de la barre pointe sur /ingredients nu, donc la recherche tapee, le tri, le groupement et les filtres actifs (tous stockes en query string) sont perdus des qu on va voir la semaine et qu on revient. La position de defilement l est aussi, puisque React Router demonte la route. Il n y a pas non plus le fondu d opacite de 250 ms du desktop.

- **Menu Aide (raccourcis + dossier de logs)** [partiel / confort / effort moyen]  
  La page Parametres remplace explicitement le dossier de logs du desktop, mais elle n affiche aucune ligne de journal : on y lit la version de l API, l etat de la base et des mesures d affichage, pas ce que le serveur a journalise. Il n y a par ailleurs aucun bouton de copie du diagnostic ni aucune entree Raccourcis clavier.
  API deja servie : GET /api/health (worker/src/routes/system.ts:9)

- **Badge X tickets en attente** [absent / gênant / effort moyen]  
  Aucune file d attente de tickets cote web, donc aucun badge et aucun moyen de savoir qu un ticket reste a traiter. Rien dans l en-tete ni sur l onglet Frigo ne signale un travail en attente.

