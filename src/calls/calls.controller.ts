import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  DefaultValuePipe,
  ParseIntPipe,
  Query,
} from '@nestjs/common';
import {
  ApiBody,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import { IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import { CallsService } from './calls.service';

class CreateEmployeeDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name?: string;
}

class CreateDealDto {
  @IsUUID()
  employeeId!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(140)
  title!: string;
}

class CreateUploadDto {
  @IsUUID()
  employeeId!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(180)
  fileName!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(100)
  contentType!: string;
}

@ApiTags('calls')
@Controller('v1')
export class CallsController {
  constructor(private readonly callsService: CallsService) {}

  @Get('employees')
  @ApiOkResponse({ description: 'Список сотрудников' })
  listEmployees() {
    return this.callsService.listEmployees();
  }

  @Post('employees')
  @ApiBody({ type: CreateEmployeeDto })
  @ApiCreatedResponse({ description: 'Сотрудник создан' })
  createEmployee(@Body() body: CreateEmployeeDto) {
    return this.callsService.createEmployee(body.name);
  }

  @Delete('employees/:employeeId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse({ description: 'Сотрудник удалён' })
  @ApiNotFoundResponse({ description: 'Сотрудник не найден' })
  @ApiConflictResponse({ description: 'У сотрудника есть связанные сделки или звонки' })
  deleteEmployee(@Param('employeeId', new ParseUUIDPipe()) employeeId: string): Promise<void> {
    return this.callsService.deleteEmployee(employeeId);
  }

  @Get('deals')
  @ApiOkResponse({ description: 'Список сделок' })
  listDeals() {
    return this.callsService.listDeals();
  }

  @Post('deals')
  @ApiBody({ type: CreateDealDto })
  @ApiCreatedResponse({ description: 'Сделка создана' })
  createDeal(@Body() body: CreateDealDto) {
    return this.callsService.createDeal(body.employeeId, body.title);
  }

  @Post('deals/:dealId/calls/upload-url')
  @ApiBody({ type: CreateUploadDto })
  @ApiCreatedResponse({ description: 'Зарегистрирован звонок и создан URL загрузки' })
  createUpload(@Param('dealId') dealId: string, @Body() body: CreateUploadDto) {
    return this.callsService.createUpload(dealId, body.employeeId, body.fileName, body.contentType);
  }

  @Post('calls/:callId/uploaded')
  @ApiOkResponse({ description: 'Файл доступен для обработки' })
  markUploaded(@Param('callId') callId: string) {
    return this.callsService.markUploaded(callId);
  }

  @Get('calls')
  @ApiOkResponse({ description: 'Страница предыдущих проверок звонков' })
  listCallHistory(@Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number) {
    return this.callsService.listCallHistory(page);
  }

  @Get('calls/:callId')
  @ApiOkResponse({ description: 'Текущий снапшот анализа' })
  getCall(@Param('callId') callId: string) {
    return this.callsService.getSnapshot(callId);
  }
}
