# Embedding layers

Embeddings are a future retrieval/similarity layer, not part of the initial objective graph implementation.

Keep the current graph explicit and queryable first:

```text
child --relation--> parent
```

Then add embeddings as projections over graph entities and interests.

## Principle

Embeddings do not replace the objective graph.

They answer a different question:

```text
objective graph: what is this connected to by concrete/cultural parentage?
embedding layer: what is close in a learned projection space?
subjective layer: what does Patch/Mia like, revisit, avoid, or recommend?
```

Do not store fuzzy `related_to` edges just because embedding distance is small. Use embeddings to derive relatedness at query time or in derived ranking views.

## Multiple spaces, not one truth

Avoid one universal embedding column. Different models expose different projections.

Possible spaces:

| Space | Input | Use |
| --- | --- | --- |
| `metadata_text` | titles, descriptions, tags, reviews, summaries | cheap cross-domain baseline |
| `audio_signal` | owned/user-supplied audio, previews, creator-submitted audio | timbre, rhythm, texture, energy, production feel |
| `lyrics_text` | lyrics or lyric summaries | themes, voice, language |
| `visual_signal` | posters, frames, images, artwork | visual/aesthetic similarity |
| `narrative_theme` | summaries, reviews, extracted themes | books, films, games, long-form works |
| `multimodal_aligned` | model-specific aligned media/text space | cross-domain discovery |
| `taste_profile` | aggregates of liked/disliked/revisited interests | subjective user/Patch preference space |

CLAP/MuLan-style music embeddings belong in `audio_signal` or a model-specific audio-text space. Multimodal binding models belong in `multimodal_aligned`.

## Future schema sketch

Do not implement until retrieval needs it.

```text
embedding_spaces
  id                text primary key, UUID
  slug              unique
  model             model name/version
  modality          text | audio | visual | video | multimodal | aggregate
  dimensions
  distance_metric   cosine | dot | l2
  description
  properties_json
  created_at

entity_embeddings
  id                text primary key, UUID
  entity_type        domain | medium | genre | work | author | collection
  entity_id
  embedding_space_id references embedding_spaces.id
  vector_blob        raw float vector, or null when stored externally
  vector_ref         optional external/local vector index reference
  source             metadata | user_file | preview | import | generated
  generated_at
  properties_json

interest_embeddings
  id                text primary key, UUID
  interest_id        references interests.id
  embedding_space_id references embedding_spaces.id
  vector_blob
  vector_ref
  generated_at
  properties_json
```

If SQLite vector search becomes useful, evaluate `sqlite-vec` or a local external vector index. Until then, store embeddings outside the first migration.

## Discovery use cases

Embeddings are useful for queries like:

```text
find works in other domains near this song's audio/text/aesthetic region
find works just outside the current taste hull
explain why an album, book, and film feel adjacent
predict known cross-domain likes from one domain's history
```

Recommendation should prefer expansion over encapsulation:

```text
not nearest neighbors only
prefer adjacent frontier regions
balance familiar, novel, challenging, and transformative
```

## TODO

- Build the taste graph without embeddings first.
- Import Last.fm/Trakt/Goodreads activity and ratings first.
- Add metadata text embeddings before raw media embeddings.
- Add audio embeddings from local owned files, user-supplied files, public previews, creator-submitted audio, or tracks streamed or downloaded through a paid account (tastebase uses Tidal).
- Never keep or serve raw copyrighted media: delete audio once it is embedded, and store only the vectors.
- Treat genre as cultural/folk taxonomy, not objective truth; embeddings can complement it but should not delete it from the graph.
- Add embedding-backed ranking views only after `retrieve_interests` works with explicit graph + scores.
