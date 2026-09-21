import { ApiProperty } from '@nestjs/swagger';

export class PageResponse {
  @ApiProperty({
    type: String,
    nullable: true,
    example: null,
    description:
      'Opaque keyset cursor. Pass it back verbatim to fetch the next page; never parse or construct one. Null on the last page.',
  })
  nextCursor!: string | null;
}
