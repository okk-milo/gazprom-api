import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiProperty, ApiTags } from '@nestjs/swagger';
import { TechnicalRepository } from './technical.repository';
import { technicalView, type TechnicalDatasetView } from './technical.types';
import { conversationReport, type ConversationReport } from './conversation-report';

export class ConversationReportResponseDto {
  @ApiProperty({ enum: ['empty', 'ready'] }) state: 'empty' | 'ready' = 'empty';
  @ApiProperty({
    type: Object,
    nullable: true,
    description:
      'Восемь недель: частота уточнений, слова/мин звучащей речи, доля длинных пауз, средняя длительность и контекст расписания. Версия conversation-report-v2.',
  })
  dataset: ConversationReport | null = null;
}

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
  @Get('report')
  @ApiOkResponse({ type: ConversationReportResponseDto })
  async report(): Promise<ConversationReportResponseDto> {
    const data = await this.repository.latest();
    if (!data) return { state: 'empty', dataset: null };
    const dataset = conversationReport(data);
    return dataset.coverage.measured
      ? { state: 'ready', dataset }
      : { state: 'empty', dataset: null };
  }
  @Get('technical')
  @ApiOkResponse({ type: TechnicalDatasetResponseDto })
  async dataset(): Promise<TechnicalDatasetResponseDto> {
    const data = await this.repository.latest();
    return data
      ? { state: 'ready', dataset: technicalView(data) }
      : { state: 'empty', dataset: null };
  }
}
