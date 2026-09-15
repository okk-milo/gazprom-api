import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { BurnoutRepository } from './burnout.repository';
import { datasetView, type BurnoutDatasetView } from './burnout.types';

type DatasetResponse = { state: 'empty' } | { state: 'ready'; dataset: BurnoutDatasetView };

@ApiTags('burnout')
@Controller('v1/burnout')
export class BurnoutController {
  constructor(private readonly repository: BurnoutRepository) {}

  @Get('dataset')
  @ApiOkResponse({
    description:
      'Восьминедельный сценарий и фактическое покрытие проверенными примерами; empty, если набор не импортирован',
  })
  async dataset(): Promise<DatasetResponse> {
    const dataset = await this.repository.latest();
    return dataset ? { state: 'ready', dataset: datasetView(dataset) } : { state: 'empty' };
  }
}
