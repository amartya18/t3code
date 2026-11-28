import Foundation

func check(_ condition: Bool, _ message: String) {
  guard condition else {
    print("FAIL: \(message)")
    exit(1)
  }
}

let root = FileManager.default.temporaryDirectory
  .appendingPathComponent("t3-diagnostics-\(UUID().uuidString)", isDirectory: true)
let store = DiagnosticStore(directory: root)
check(store.pending().isEmpty, "a missing folder has nothing pending")

let crash = #"{"crashDiagnostics":[{"diagnosticMetaData":{"signal":11,"exceptionType":1}}]}"#
store.save(Data(crash.utf8), now: Date(timeIntervalSince1970: 1))
let saved = store.pending()
check(saved.count == 1 && saved[0]["json"] == crash, "a saved payload reads back as written")

store.save(Data(count: DiagnosticStore.maxBytes + 1), now: Date(timeIntervalSince1970: 2))
store.save(Data(), now: Date(timeIntervalSince1970: 3))
check(store.pending().count == 1, "empty and oversized payloads are not kept")

for index in 0..<25 {
  store.save(Data(#"{"n":\#(index)}"#.utf8), now: Date(timeIntervalSince1970: Double(100 + index)))
}
let kept = store.pending()
check(kept.count == DiagnosticStore.maxFiles, "keeps at most \(DiagnosticStore.maxFiles) files")
check(kept.first?["json"] == #"{"n":5}"#, "drops the oldest first")
check(kept.last?["json"] == #"{"n":24}"#, "keeps the newest")

store.remove("../\(kept[0]["id"]!)")
check(store.pending().count == DiagnosticStore.maxFiles, "an id it did not hand out removes nothing")
store.remove(kept[0]["id"]!)
check(store.pending().first?["json"] == #"{"n":6}"#, "remove deletes exactly that payload")

try? FileManager.default.removeItem(at: root)
print("T3_DIAGNOSTICS_STORE_OK")
