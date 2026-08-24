/**
 * Tests for the contract error decoding utilities, verifying that the
 * XDR-typed accessors extract the correct error code from a realistic
 * TransactionResult.
 */
import { describe, it, expect } from 'vitest'
import { xdr } from 'stellar-sdk'
import { extractContractErrorCode, getContractErrorMessage, parseTransactionResultError } from './contractErrors'

/**
 * Build a realistic SDK TransactionResult XDR for a Soroban contract failure.
 */
function contractFailureXdr(contractCode: number): xdr.TransactionResult {
  const scError = xdr.ScError.sceContract(contractCode)
  const invokeResult = xdr.InvokeHostFunctionResult.invokeHostFunctionTrapped(scError)
  const opTr = xdr.OperationResultTr.invokeHostFunction(invokeResult)
  const opResult = xdr.OperationResult.opInner(opTr)
  const resultResult = xdr.TransactionResultResult.txFailed([opResult])
  return new xdr.TransactionResult({
    feeCharged: xdr.Int64.fromString('100'),
    result: resultResult,
    ext: new xdr.TransactionResultExt(0),
  })
}

describe('extractContractErrorCode', () => {
  it('extracts a known contract error code from a realistic TransactionResult', () => {
    const result = contractFailureXdr(7) // Burn amount exceeds
    expect(extractContractErrorCode(result)).toBe(7)
  })

  it('extracts different error codes correctly', () => {
    expect(extractContractErrorCode(contractFailureXdr(1))).toBe(1)  // Insufficient fee
    expect(extractContractErrorCode(contractFailureXdr(10))).toBe(10) // Contract paused
    expect(extractContractErrorCode(contractFailureXdr(16))).toBe(16) // Max supply
  })

  it('returns undefined for a non-contract non-Soroban failure', () => {
    // A txFailed result with no operation results (e.g. bad auth)
    const resultResult = xdr.TransactionResultResult.txBadAuth()
    const result = new xdr.TransactionResult({
      feeCharged: xdr.Int64.fromString('100'),
      result: resultResult,
      ext: new xdr.TransactionResultExt(0),
    })
    expect(extractContractErrorCode(result)).toBeUndefined()
  })

  it('returns undefined for a non-txFailed result', () => {
    const result = new xdr.TransactionResult({
      feeCharged: xdr.Int64.fromString('100'),
      result: xdr.TransactionResultResult.txSuccess([]),
      ext: new xdr.TransactionResultExt(0),
    })
    expect(extractContractErrorCode(result)).toBeUndefined()
  })

  it('returns undefined for a non-Soroban operation failure', () => {
    // A payment operation failure, not INVOKE_HOST_FUNCTION
    const opResult = xdr.OperationResult.opInner(
      xdr.OperationResultTr.payment(
        xdr.PaymentResult.paymentSuccess(),
      ),
    )
    const resultResult = xdr.TransactionResultResult.txFailed([opResult])
    const result = new xdr.TransactionResult({
      feeCharged: xdr.Int64.fromString('100'),
      result: resultResult,
      ext: new xdr.TransactionResultExt(0),
    })
    expect(extractContractErrorCode(result)).toBeUndefined()
  })

  it('returns undefined for a non-contract ScError (e.g. WASM_VM)', () => {
    const scError = xdr.ScError.sceWasmVm(0)
    const invokeResult = xdr.InvokeHostFunctionResult.invokeHostFunctionTrapped(scError)
    const opTr = xdr.OperationResultTr.invokeHostFunction(invokeResult)
    const opResult = xdr.OperationResult.opInner(opTr)
    const resultResult = xdr.TransactionResultResult.txFailed([opResult])
    const result = new xdr.TransactionResult({
      feeCharged: xdr.Int64.fromString('100'),
      result: resultResult,
      ext: new xdr.TransactionResultExt(0),
    })
    expect(extractContractErrorCode(result)).toBeUndefined()
  })
})

describe('parseTransactionResultError', () => {
  it('returns the correct mapped message and code for a known error', () => {
    const { message, contractErrorCode } = parseTransactionResultError(contractFailureXdr(7))
    expect(contractErrorCode).toBe(7)
    expect(message).toBe(getContractErrorMessage(7))
  })

  it('returns a fallback message for an unknown error code', () => {
    // Code 99 does not exist in CONTRACT_ERROR_MESSAGES
    const { message, contractErrorCode } = parseTransactionResultError(contractFailureXdr(99))
    expect(contractErrorCode).toBe(99)
    expect(message).toBe('An unexpected contract error occurred (code 99).')
  })

  it('returns a generic message for a non-contract failure', () => {
    const result = new xdr.TransactionResult({
      feeCharged: xdr.Int64.fromString('100'),
      result: xdr.TransactionResultResult.txBadAuth(),
      ext: new xdr.TransactionResultExt(0),
    })
    const { message, contractErrorCode } = parseTransactionResultError(result)
    expect(contractErrorCode).toBeUndefined()
    expect(message).toBe('The network rejected the transaction.')
  })
})