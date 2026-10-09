# Jeu d'icônes

67 icônes : **10 rayons** et 57 d'interface. Elles remplacent les émojis, qui
changeaient de dessin d'un appareil à l'autre, ne suivaient pas le thème sombre
et ne pouvaient pas illustrer un rayon.

## Les dessins viennent de Lucide et de Tabler

| Source | Version | Licence | Texte à conserver |
|---|---|---|---|
| [lucide.dev](https://lucide.dev) | 0.469.0 | ISC, MIT pour ce qui dérive de Feather | [LICENSE-lucide.txt](LICENSE-lucide.txt) |
| [tabler.io/icons](https://tabler.io/icons) | 3.31.0 | MIT | [LICENSE-tabler.txt](LICENSE-tabler.txt) |

Les deux textes sont **à conserver** : c'est la condition de redistribution, et
ce dépôt est public. Le commentaire au-dessus de chaque icône dit laquelle des
deux sources l'a fournie.

Deux sources et non une, parce que Lucide n'a pas tout : son `milk` est une
**bouteille**, quand le lait s'achète en brique. Tabler en a une, sur la même
grille 24 et le même trait. Dans `MAP`, un nom préfixé `tabler:` va la chercher
là-bas. Tabler ouvre chaque icône par un rectangle transparent de 24 × 24 que
l'import supprime : il ne dessine rien, mais fausserait toute mesure de boîte
englobante.

Ils ont remplacé un jeu dessiné à la main. Ce n'était pas une question de goût :
un jeu maison demande d'être maintenu à chaque icône manquante, et il vieillit
seul. Lucide est cohérent, maintenu, et déjà en grille 24.

### Pourquoi pas la dépendance `lucide-react`

Le paquet expose un composant par icône, tire React, et laisse **chaque icône
poser ses propres attributs** — exactement ce que `Icon.tsx` interdit depuis le
début. On prend donc la matière (les chemins) et on garde le cadre.

Conséquence utile : Lucide publie ses dessins à `stroke-width: 2`, on les rend à
**1,6**. C'est possible précisément parce que l'épaisseur n'est écrite nulle part
dans les chemins.

## Règles qui tiennent, quelle que soit la source

| Règle | Valeur |
|---|---|
| Grille | `viewBox="0 0 24 24"` |
| Trait | `stroke="currentColor"`, `fill="none"` |
| Épaisseur | `1.6`, posée par `Icon.tsx` |
| Couleur | aucune valeur littérale. `none` ou `currentColor`, rien d'autre |

La dernière ligne est vérifiée par un test : une couleur en dur figerait
l'icône et lui ferait rater la teinte de son rayon comme le thème sombre.
Lucide en pose lui-même quelques-unes (le trou de l'étiquette, l'œil du
poisson), toutes en `currentColor`.

## Où vit quoi

```
icons/
├── Icon.tsx            rendu d'une icône du jeu
├── RayonIcon.tsx       rendu d'un glyphe de rayon (jeu OU icône collée)
├── registry.ts         fusion des deux familles + type `IconName`
├── resolve.ts          libellé de rayon -> icône déduite
├── rayonStyle.ts       réglages de l'utilisateur -> glyphe + teinte
├── LICENSE-lucide.txt  à conserver
└── paths/
    ├── rayons.ts       GÉNÉRÉ — ne pas éditer
    ├── ui.ts           GÉNÉRÉ — ne pas éditer
    └── overrides.ts    dessins maison, à la main
```

`overrides.ts` est fusionné **en dernier** dans `registry.ts` : une clé présente
des deux côtés prend la version maison. C'est le seul endroit où dessiner soi-
même sans se faire écraser au prochain import. L'entrée Lucide correspondante
reste dans `MAP` : retirer une ligne d'`overrides.ts` rend alors l'icône Lucide,
plutôt que de faire disparaître l'icône.

À n'utiliser que lorsque Lucide ne dit pas la bonne chose — chaque dessin ajouté
là est un dessin à maintenir seul, ce qui est exactement la raison pour laquelle
le jeu maison a été abandonné. Aujourd'hui : **une seule entrée**, la brique de
lait, Lucide ne proposant qu'une bouteille.

## Ajouter ou changer une icône

`paths/*.ts` est **généré**. Une retouche à la main serait écrasée au prochain
import.

1. Ajouter la ligne dans `MAP`, dans `scripts/import-lucide.mjs`.
2. `node scripts/import-lucide.mjs` — il récupère, filtre et réécrit.
3. `npm --workspace @prandia/web run test`.

Le script passe chaque SVG par `sanitizeSvg`, l'assainisseur écrit pour les
icônes collées par l'utilisateur. Même besoin, même code : retirer la balise
racine et ne garder que les formes.

Il refuse une icône dont la grille n'est pas `0 0 24 24`, et connaît quelques
noms de repli — Lucide renomme régulièrement (`filter` est devenu `funnel`
ailleurs, `bar-chart` est devenu `chart-column`). La version est **figée** :
`latest` rendrait le script non reproductible d'un mois sur l'autre.

## Les icônes de l'utilisateur

Un SVG collé dans **Paramètres → Mes icônes** ne passe pas par ici : il vit en
base, assaini par le serveur (`worker/src/routes/icons.ts`), et se réfère depuis
un rayon sous la forme `custom:12`. Voir `rayonStyle.ts`.

## Ce que le jeu ne couvre pas

Il n'y a **pas d'icône par aliment**, délibérément. Un ingrédient porte l'icône
de son rayon, donnée qu'il a déjà. Dessiner par aliment supposerait une table de
mots-clés qui se trompe en silence et rend un dessin faux — pire qu'un dessin
générique.
