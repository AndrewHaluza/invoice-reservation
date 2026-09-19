import { InvoiceReservationEntity } from '../infrastructure/entities/invoice-reservation.entity';

export interface MoneyBody {
  readonly amountMinor: string;
  readonly currency: string;
}

export interface ReservationFxBody {
  readonly rate: string;
  readonly effectiveAt: string;
  readonly source: string;
}

export interface ReservationBody {
  readonly invoiceId: string;
  readonly programId: string;
  readonly status: InvoiceReservationEntity['status'];
  readonly invoiceAmount: MoneyBody;
  readonly reserved: MoneyBody;
  readonly outstanding: {
    readonly invoice: MoneyBody;
    readonly reserved: MoneyBody;
  };
  readonly fx: ReservationFxBody | null;
  readonly createdAt: string;
}

export function toReservationBody(
  row: InvoiceReservationEntity,
): ReservationBody {
  return {
    invoiceId: row.invoiceId,
    programId: row.programId,
    status: row.status,
    invoiceAmount: {
      amountMinor: row.invoiceAmountMinor.toString(),
      currency: row.invoiceCurrency,
    },
    reserved: {
      amountMinor: row.reservedMinor.toString(),
      currency: row.programCurrency,
    },
    outstanding: {
      invoice: {
        amountMinor: row.outstandingInvoiceMinor.toString(),
        currency: row.invoiceCurrency,
      },
      reserved: {
        amountMinor: row.outstandingReservedMinor.toString(),
        currency: row.programCurrency,
      },
    },
    fx:
      row.fxRate === null ||
      row.fxRateEffectiveAt === null ||
      row.fxRateSource === null
        ? null
        : {
            rate: row.fxRate,
            effectiveAt: row.fxRateEffectiveAt.toISOString(),
            source: row.fxRateSource,
          },
    createdAt: row.createdAt.toISOString(),
  };
}
