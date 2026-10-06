// slate-watcher: a LaunchAgent that runs `SlateWiper --snapshot` when the Mac is
// about to power off / log out (and optionally sleep), per autoSnapshot in
// the config (re-read on every event, so edits apply immediately). argv[1] is the
// slatewiper checkout; mine/slatewipe.config.json wins over the example config.
// It launches the snapshot through SlateWiper.app so permissions stay attributed
// to the app. Build: cc -framework AppKit -fobjc-arc -o slate-watcher slate-watcher.m
#import <AppKit/AppKit.h>

static NSString *home, *repo;
static BOOL flag(NSString *key) {
  NSData *d = [NSData dataWithContentsOfFile:[repo stringByAppendingPathComponent:@"mine/slatewipe.config.json"]]
    ?: [NSData dataWithContentsOfFile:[repo stringByAppendingPathComponent:@"slatewipe.config.example.json"]];
  if (!d) return NO;
  NSDictionary *j = [NSJSONSerialization JSONObjectWithData:d options:0 error:nil];
  return [j[@"autoSnapshot"][key] boolValue];
}
static void logline(NSString *s) {
  NSString *log = [home stringByAppendingPathComponent:@"slate/watcher.log"];
  NSString *line = [NSString stringWithFormat:@"%@ %@\n", [NSDate date], s];
  NSFileHandle *h = [NSFileHandle fileHandleForWritingAtPath:log];
  if (!h) { [[NSFileManager defaultManager] createFileAtPath:log contents:nil attributes:nil]; h = [NSFileHandle fileHandleForWritingAtPath:log]; }
  [h seekToEndOfFile]; [h writeData:[line dataUsingEncoding:NSUTF8StringEncoding]]; [h closeFile];
}
static void snapshot(NSString *why) {
  logline([NSString stringWithFormat:@"%@ → snapshot", why]);
  NSTask *t = [NSTask new];
  t.launchPath = @"/usr/bin/open";
  t.arguments = @[@"-W", @"-a", [home stringByAppendingPathComponent:@"Applications/SlateWiper.app"], @"--args", @"--snapshot"];
  @try { [t launch]; [t waitUntilExit]; logline([NSString stringWithFormat:@"snapshot done (exit %d)", t.terminationStatus]); }
  @catch (NSException *e) { logline([NSString stringWithFormat:@"snapshot failed: %@", e.reason]); }
}
int main(int argc, char **argv) {
  @autoreleasepool {
    home = NSHomeDirectory();
    if (argc < 2) { fprintf(stderr, "usage: slate-watcher /path/to/slatewiper\n"); return 1; }
    repo = [NSString stringWithUTF8String:argv[1]];
    [NSApplication sharedApplication];
    NSNotificationCenter *nc = [[NSWorkspace sharedWorkspace] notificationCenter];
    [nc addObserverForName:NSWorkspaceWillPowerOffNotification object:nil queue:nil usingBlock:^(NSNotification *n) { if (flag(@"onPowerOff")) snapshot(@"power off / logout"); }];
    [nc addObserverForName:NSWorkspaceWillSleepNotification object:nil queue:nil usingBlock:^(NSNotification *n) { if (flag(@"onSleep")) snapshot(@"sleep"); }];
    logline(@"watcher started");
    [[NSRunLoop currentRunLoop] run];
  }
  return 0;
}
