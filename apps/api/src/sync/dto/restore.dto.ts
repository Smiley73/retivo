import { IsNotEmpty, IsString, Matches, MaxLength } from 'class-validator';

/**
 * Body for `POST /api/v1/sync/restore`. The `snapshotId` selects which
 * S3 snapshot object (`${householdId}/${snapshotId}.json.gz`) to restore
 * the workspace to.
 *
 * The `@Matches` guard allows only the characters the compactor's
 * ISO-derived key format uses — alphanumerics, `-`, `.`, `:` (the
 * `\w` class covers `_` and digits too). The critical exclusion is
 * `/`: it is the only character that could escape the household prefix
 * in the S3 object key. `..` is harmless here because S3 object keys are
 * not file-system paths — they do not normalize `..` without a
 * surrounding `/`, so `${householdId}/2026-05-31T12..00.json.gz` simply
 * resolves to a key that does not exist (a soft 404), never another
 * household's data.
 */
export class RestoreDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  @Matches(/^[\w.\-:]+$/, {
    message: 'snapshotId contains invalid characters.',
  })
  snapshotId!: string;
}
