# bookstack-mcp-server

Serveur MCP pour un wiki [BookStack](https://www.bookstackapp.com/) auto-hébergé.
Il permet à un agent de chercher dans le wiki, de lire des pages, et d'y écrire de
la documentation — typiquement pour capturer les conclusions d'une session de
travail sans quitter la conversation.

**Seule la suppression de page est autorisée**, et uniquement page par page,
confirmée par son titre et envoyée à la corbeille BookStack. Les books, les
chapitres et les étagères **ne peuvent pas être supprimés** depuis ce serveur :
supprimer un conteneur emporte tout ce qu'il contient, ça reste une action
humaine faite depuis l'interface web.

---

## 1. Créer un token d'API dans BookStack

1. Dans BookStack, ouvre le menu de ton profil → **Edit Profile** → onglet **API Tokens** → **Create Token**.
2. Note le **Token ID** et le **Token Secret** (le secret n'est affiché qu'une fois).
3. Vérifie que le rôle du compte possède la permission **Access system API**
   (Settings → Roles → *ton rôle* → System Permissions).

Le token hérite des permissions du compte : une page dans un book restreint
restera invisible pour le serveur MCP si le compte n'y a pas accès. C'est le
moyen le plus simple de cloisonner ce que l'agent peut voir — crée un compte
dédié avec un rôle restreint si tu veux limiter la surface.

## 2. Installer

```bash
git clone https://github.com/jbivia/bookstack-mcp-server.git
cd bookstack-mcp-server
nvm use          # lit .nvmrc -> Node 24
npm install
npm run build
```

**Node 24 LTS requis** (`engines: >=24`). Le code cible ES2024 et s'appuie sur le
`fetch` natif, `AbortSignal.timeout()` et `--env-file-if-exists`.

## 3. Configurer et tester

Trois variables d'environnement :

| Variable | Exemple | Rôle |
|---|---|---|
| `BOOKSTACK_BASE_URL` | `https://wiki.example.com` | URL racine du wiki. Le `/api` final est optionnel. |
| `BOOKSTACK_TOKEN_ID` | `AbCdEf…` | Token ID |
| `BOOKSTACK_TOKEN_SECRET` | `123456…` | Token Secret |

Test de connectivité avant de brancher quoi que ce soit :

```bash
BOOKSTACK_BASE_URL=https://wiki.example.com \
BOOKSTACK_TOKEN_ID=xxx \
BOOKSTACK_TOKEN_SECRET=yyy \
node dist/index.js --check
```

Ou, en remplissant `.env` à partir de `.env.example` (Node 24 lit le fichier
nativement, sans dépendance `dotenv`) :

```bash
npm run check
```

Sortie attendue :

```
Endpoint: https://wiki.example.com/api
Connection OK. 12 book(s) visible to this token.
```

`node dist/index.js --help` rappelle les flags et les variables attendues.

Si le wiki utilise une CA privée, pointe `NODE_EXTRA_CA_CERTS` sur le certificat
racine plutôt que de désactiver la vérification TLS.

## 4. Brancher sur un client MCP

### Claude Code

```bash
claude mcp add bookstack \
  --scope user \
  --env BOOKSTACK_BASE_URL=https://wiki.example.com \
  --env BOOKSTACK_TOKEN_ID=xxx \
  --env BOOKSTACK_TOKEN_SECRET=yyy \
  -- node /chemin/absolu/vers/bookstack-mcp-server/dist/index.js
```

### Claude Desktop

Dans `claude_desktop_config.json` :

```json
{
  "mcpServers": {
    "bookstack": {
      "command": "node",
      "args": ["/chemin/absolu/vers/bookstack-mcp-server/dist/index.js"],
      "env": {
        "BOOKSTACK_BASE_URL": "https://wiki.example.com",
        "BOOKSTACK_TOKEN_ID": "xxx",
        "BOOKSTACK_TOKEN_SECRET": "yyy"
      }
    }
  }
}
```

Le chemin doit être absolu, et le serveur tourne sur la machine cliente : il faut
donc que celle-ci puisse résoudre et joindre l'hôte du wiki (LAN ou VPN).

Si tu utilises `nvm`, `node` doit pointer sur la 24 dans l'environnement qui lance
le client MCP. En cas de doute, mets le chemin absolu du binaire
(`~/.nvm/versions/node/v24.x.y/bin/node`) plutôt que `node`.

### Inspecteur MCP

```bash
npm run inspect
```

---

## Outils exposés

| Outil | Écrit ? | Usage |
|---|---|---|
| `bookstack_search` | non | Recherche plein texte, point d'entrée principal |
| `bookstack_list_books` | non | Lister les books |
| `bookstack_get_book` | non | Métadonnées + arborescence chapitres/pages (donne les ids) |
| `bookstack_list_shelves` | non | Lister les étagères |
| `bookstack_get_shelf` | non | Détail d'une étagère + books rattachés |
| `bookstack_list_chapters` | non | Lister les chapitres, filtrable par book |
| `bookstack_list_pages` | non | Lister les pages (métadonnées seules) |
| `bookstack_get_page` | non | Lire une page (markdown, html, ou métadonnées seules) |
| `bookstack_create_book` | oui | Créer un book |
| `bookstack_create_chapter` | oui | Créer un chapitre |
| `bookstack_create_page` | oui | Créer une page |
| `bookstack_update_book` | oui | Renommer un book, changer sa description ou ses tags |
| `bookstack_update_chapter` | oui | Renommer un chapitre, changer description/tags, le déplacer |
| `bookstack_update_page` | oui | Ajouter à / réécrire une page (`append` par défaut), ou la déplacer |
| `bookstack_update_shelf` | oui | Rattacher/détacher des books, renommer (`add` par défaut) |
| `bookstack_delete_page` | oui | **Supprimer une page** (corbeille, titre à confirmer) |
| `bookstack_save_note` | oui | **Workflow** : capturer une note en un appel, par nom |

### `bookstack_save_note`

L'outil pensé pour l'usage « note ça dans le wiki » en cours de session. Il
résout le book (et le chapitre) **par nom**, les crée si besoin, puis crée la
page ou **ajoute une section** à la page existante portant ce titre. Aucun
contenu n'est jamais écrasé : rappeler l'outil avec le même titre empile les
sections sur une seule page.

### Suppression : page seulement, corbeille, titre à confirmer

`bookstack_delete_page` est **le seul outil de suppression** du serveur. Il n'y a
pas d'équivalent pour les books, les chapitres ou les étagères, et il n'est pas
prévu d'en ajouter : supprimer un book emporterait tous ses chapitres et toutes
ses pages, ce qui n'est pas une décision à confier à un agent.

Deux garde-fous :

- **Corbeille, pas destruction.** `DELETE /api/pages/{id}` envoie la page dans la
  corbeille BookStack ; elle reste restaurable depuis **Settings → Recycle Bin**
  de l'interface web. Le serveur n'expose pas `/api/recycle-bin` : il ne peut ni
  vider la corbeille, ni restaurer une page.
- **Confirmation par le titre.** L'outil exige un `confirm_title` qui doit
  correspondre au titre réel de la page. La page est lue avant toute suppression
  et, en cas d'écart, l'erreur donne le vrai titre sans rien supprimer — un
  `page_id` inventé échoue au lieu d'effacer autre chose. La comparaison ignore la
  casse, les espaces et l'emphase markdown : inutile de recopier au caractère près.

### Déplacer une page ou un chapitre

`bookstack_update_page` accepte `book_id` (déplace la page à la racine du book)
ou `chapter_id` (la range dans un chapitre) — **les deux à la fois sont
refusés** : une page n'a qu'un seul emplacement, l'ambiguïté doit échouer plutôt
que d'être tranchée en silence. Le déplacement se combine avec une écriture de
contenu dans le même appel, et la réponse rappelle d'où venait la page.

`bookstack_update_chapter` déplace de même un chapitre vers un autre book, avec
toutes ses pages. Changer de book change le slug dans l'URL : les liens notés
avant le déplacement sont périmés, la réponse le signale.

### Étagères : le piège du remplacement

L'API BookStack n'expose l'appartenance d'un book à une étagère que via un champ
`books` sur `PUT /api/shelves/{id}`, et **ce tableau remplace tout le contenu de
l'étagère**. Envoyer naïvement l'id d'un nouveau book détacherait tous les
autres.

`bookstack_update_shelf` lit donc l'état courant et fusionne :
`books_mode="add"` (défaut) n'enlève jamais rien, `"remove"` retire uniquement
les ids nommés, et seul `"replace"` reproduit le comportement brut de l'API. La
réponse détaille `previous_book_ids`, `added` et `removed` pour que le résultat
soit vérifiable.

### Markdown attendu, pas d'images

Le format attendu pour le contenu de ce wiki est le **markdown**. L'argument
`html` des outils d'écriture n'existe que pour les pages déjà rédigées dans
l'éditeur WYSIWYG, qui n'ont pas de source markdown : BookStack stocke alors la
page en HTML seul, et l'`append` de markdown dessus est impossible sans perte —
le serveur renvoie une erreur explicite qui indique de renvoyer le contenu en
HTML. Les pages créées ici étant toujours en markdown, le cas ne se pose que sur
des pages écrites à la main dans l'interface.

**Aucune image ne peut être envoyée.** Ce serveur n'expose pas la galerie
d'images de l'API BookStack, et un agent n'a de toute façon pas de fichier à
téléverser. Les schémas — architecture, arborescences, flux — se dessinent donc
en **ASCII dans un bloc de code**. C'est lisible, cherchable, diffable, et ça
survit à un export.

Le serveur refuse le contenu dont une image ne peut pas s'afficher : chemin
relatif (`./schema.png`), URI `data:`, `file://`, chemin Windows, et chemin de
fichier absolu (`/home/...`, `/tmp/...`, qui ressemblent à une URL racine-relative
sans en être une). L'erreur nomme les sources fautives et rappelle l'alternative
ASCII. Une URL absolue en `http(s)` ou un vrai chemin racine-relatif du wiki
(`/uploads/...`) sont laissés passer : ils peuvent résoudre. Les images citées
**dans un bloc de code** ou entre backticks sont ignorées — c'est un exemple, pas
un lien mort.

### Pas de titre en double

BookStack affiche déjà le champ `name` de la page comme son H1. Un corps qui
commence par `# <même titre>` fait donc apparaître le titre deux fois. Les
descriptions de `bookstack_create_page` et `bookstack_update_page` demandent
explicitement de commencer à `## `, et le serveur retire de lui-même un titre de
niveau 1 en tête de contenu quand il reprend le nom de la page — en ATX
(`# Titre`), en setext (`Titre` souligné de `===`) ou en HTML (`<h1>`). La
comparaison ignore la casse, les espaces, l'emphase markdown et la ponctuation
finale ; un titre de niveau 1 qui dit autre chose est conservé tel quel.

Le nettoyage s'applique là où le contenu arrive en tête de page : à la création
(y compris via `bookstack_save_note`), en `mode="replace"` et en
`mode="prepend"`. En `mode="append"` le contenu est ajouté en bas, où la question
ne se pose pas. Quand un titre a été retiré, la réponse de l'outil le signale,
pour que l'agent cesse de l'émettre.

---

## Resources exposées

En plus des outils, chaque book est accessible **par URI**, sans appel d'outil.
Dans Claude Code, tape `@bookstack:` : les books apparaissent dans
l'autocomplétion et s'attachent comme un fichier.

| URI | Contenu | Listée ? |
|---|---|---|
| `bookstack://book/{book_id}` | Métadonnées + arborescence chapitres/pages, en markdown. Identique à `bookstack_get_book` | oui |
| `bookstack://book/{book_id}/content` | Le book entier en markdown, via `/api/books/{id}/export/markdown` | non |

```
@bookstack:bookstack://book/9            le plan du book 9
@bookstack:bookstack://book/9/content    tout son texte
```

La seconde URI n'est **pas listée** : elle reste découvrable via
`resources/templates/list`, mais aucun client ne la propose spontanément à côté
des autres. Sa description dit à l'agent de ne pas la lire de sa propre
initiative — un book de taille moyenne pèse plusieurs dizaines de milliers de
caractères, et rien ne justifie de les faire entrer dans le contexte tant que
l'utilisateur n'a pas demandé le texte entier. Le plan suffit à trouver les
`page_id` à lire ensuite avec `bookstack_get_page`.

Tous les clients MCP ne gèrent pas les resources. Ceux qui ne les gèrent pas
ignorent simplement la capability : les outils continuent de fonctionner.

## Architecture

```
src/
├── index.ts              # enregistrement outils + resources, transport stdio, mode --check
├── constants.ts          # limites, timeouts, noms de variables d'env
├── types.ts              # interfaces des entités BookStack
├── schemas/common.ts     # fragments Zod partagés (pagination, tags, format)
├── services/
│   ├── client.ts         # auth, timeouts, traduction des erreurs HTTP en messages actionnables
│   ├── list.ts           # helper générique pour les endpoints de listing
│   ├── links.ts          # résolution book_id -> slug (cache TTL) pour les URL de page
│   ├── compat.ts         # réécriture du dialecte JSON Schema pour les clients stricts
│   ├── entities.ts       # mapping entité BookStack → résumé normalisé
│   ├── title.ts          # retrait du H1 de corps qui redouble le titre de page
│   ├── authoring.ts      # conventions d'écriture : markdown, pas d'images (ASCII à la place)
│   └── format.ts         # pagination, rendu markdown, troncature
├── resources/books.ts    # books exposés en resources MCP (plan + export markdown)
└── tools/                # un fichier par domaine
```

Points de conception notables :

- **Erreurs actionnables** : chaque code HTTP est traduit en message qui nomme la
  cause probable et l'action suivante (401 → vérifier le token, 404 → les ids ne
  sont pas partagés entre types, 422 → champ manquant).
- **Limite de contexte** : les réponses sont plafonnées à 25 000 caractères, avec
  troncature progressive des listes et un message indiquant l'`offset` à utiliser.
  Dans un *listing*, la description d'un item est en plus écourtée à 300
  caractères et suffixée d'un `…`. Les lectures unitaires et les écritures
  (`get_book`, `get_shelf`, `update_book`…) renvoient toujours la description
  entière : un agent vérifie son écriture en la relisant, et un écho
  silencieusement raccourci se lirait comme une perte de données dans le wiki.
  Les lectures de resources ont leur propre plafond, à 100 000 : une resource
  arrive dans le contexte parce que quelqu'un l'a attachée ou demandée, un
  résultat d'outil parce que l'agent en a décidé ainsi. Le lecteur d'une
  resource a déjà accepté le coût, et couper un book au milieu d'une phrase ne
  rendrait service à personne.
- **Double format** : chaque outil de lecture accepte `response_format` en
  `markdown` (compact, par défaut) ou `json` (payload complet).
- **Listing de resources non paginé** : le SDK appelle le callback `list` sans
  curseur et jette le `nextCursor` qu'on lui renvoie
  (`server/mcp.js`, handler `resources/list`). Le listing est donc
  tout-ou-rien : il est plafonné à 100 books, triés par date de mise à jour
  décroissante pour que la coupe tombe sur les moins susceptibles d'être
  cherchés.
- **Erreurs de resource** : une resource n'a pas d'équivalent du champ `isError`
  des outils — une lecture renvoie du contenu ou lève. Les erreurs sont donc
  converties en erreur JSON-RPC en conservant le message actionnable de
  `client.ts`, et sans passer par le `McpError` du SDK, dont le constructeur
  préfixe le message d'un `MCP error <code>:` que le client réaffiche ensuite en
  double.
- **URL de page** : l'API ne renvoie que `book_id` sur une page, alors qu'une URL
  s'écrit `/books/{slug-du-book}/page/{slug-de-la-page}`. Le serveur résout le
  slug du book et le met en cache 10 minutes (TTL court : un book renommé change
  de slug, et un lien mort est pire qu'un appel de plus). Les lectures et
  créations de book alimentent ce cache gratuitement, et `bookstack_update_book`
  le rafraîchit après un renommage, donc la résolution est le plus souvent sans
  coût et jamais périmée par nos propres écritures. Elle est appliquée aux opérations mono-page seulement :
  sur un listing, des pages réparties sur de nombreux books déclencheraient
  autant de requêtes. Tout échec de résolution est avalé — une URL est un
  confort, elle ne doit jamais faire échouer une écriture réussie.

## Compatibilité des clients MCP

Le SDK MCP génère les schémas d'outils avec `zod-to-json-schema`, qui les
estampille `draft-07`. Certains clients valident avec un Ajv configuré pour
`2020-12` seulement et refusent tout autre dialecte déclaré :

```
Tool 'bookstack_list_shelves' has an invalid outputSchema:
JSON Schema declares an unsupported dialect ("$schema": ".../draft-07/schema#")
```

Les mots-clés réellement employés ici (`type`, `properties`, `required`,
`items`, `enum`, `minimum`, `minLength`, `additionalProperties`) ont une
sémantique identique dans les deux dialectes : seule la déclaration est
inexacte. `services/compat.ts` la réécrit sur les messages sortants, au niveau
du transport, ce qui reste indépendant de la façon dont le SDK construit et met
en cache sa liste d'outils.

C'est un contournement, pas un correctif : à supprimer le jour où le SDK émet
du 2020-12 nativement.

## Pistes d'extension

- Attachments et image gallery (`/api/attachments`, `/api/image-gallery`) pour
  joindre des fichiers aux pages.
- Export d'un book entier en markdown (`/api/books/{id}/export/markdown`).
- `bookstack_create_shelf` : volontairement absent, les étagères étant une
  décision d'organisation qui gagne à rester manuelle. Trivial à ajouter si tu
  changes d'avis (`POST /api/shelves`, même corps que l'update).
- Restauration depuis la corbeille (`/api/recycle-bin`) : aujourd'hui une page
  supprimée ne se récupère que depuis l'interface web.

## Licence

[MIT](LICENSE).
