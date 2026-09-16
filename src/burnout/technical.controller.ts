import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiProperty, ApiTags } from '@nestjs/swagger';
import { TechnicalRepository } from './technical.repository';
import { technicalView, type TechnicalDatasetView } from './technical.types';

export class TechnicalDatasetResponseDto {
  @ApiProperty({ enum: ['empty', 'ready'] }) state: 'empty' | 'ready' = 'empty';
  @ApiProperty({
    type: Object,
    nullable: true,
    description:
      'Технические признаки диалогов, восемь условных недель, измеренное покрытие, сравнения и ссылки на исходные реплики. Не психологические шкалы.',
  })
  dataset: TechnicalDatasetView | null = null;
}

@ApiTags('burnout')
@Controller('v1/burnout')
export class TechnicalController {
  constructor(private readonly repository: TechnicalRepository) {}
  @Get('technical')
  @ApiOkResponse({ type: TechnicalDatasetResponseDto })
  async dataset(): Promise<TechnicalDatasetResponseDto> {
    const data = await this.repository.latest();
    return data
      ? { state: 'ready', dataset: technicalView(data) }
      : { state: 'empty', dataset: null };
  }
}
