/** The shape of `MXDiagnosticPayload.jsonRepresentation()` for one crash. */
export const sampleCrashPayload = {
  timeStampBegin: "2026-11-28 09:12:00",
  timeStampEnd: "2026-11-28 09:12:00",
  crashDiagnostics: [
    {
      version: "1.0.0",
      callStackTree: {
        callStackPerThread: true,
        callStacks: [
          {
            threadAttributed: true,
            callStackRootFrames: [
              {
                binaryUUID: "6A8F2B9E-1C3D-4E5F-8A9B-0C1D2E3F4A5B",
                offsetIntoBinaryTextSegment: 123456,
                sampleCount: 1,
                binaryName: "libBNNS.dylib",
                address: 7_000_000_000,
                subFrames: [
                  {
                    binaryUUID: "7B9F3C0F-2D4E-5F60-9B0C-1D2E3F4A5B6C",
                    offsetIntoBinaryTextSegment: 654321,
                    sampleCount: 1,
                    binaryName: "Espresso",
                    address: 7_000_100_000,
                  },
                ],
              },
            ],
          },
        ],
      },
      diagnosticMetaData: {
        appBuildVersion: "42",
        appVersion: "0.1.11",
        bundleIdentifier: "com.example.t3code",
        deviceType: "iPhone17,1",
        exceptionCode: 0,
        exceptionType: 1,
        isTestFlightApp: false,
        lowPowerModeEnabled: false,
        osVersion: "iPhone OS 26.1 (23B85)",
        platformArchitecture: "arm64e",
        regionFormat: "US",
        signal: 11,
        terminationReason: "Thread stack size exceeded due to excessive recursion",
        virtualMemoryRegionInfo: "0 is not in any region.",
      },
    },
  ],
};
