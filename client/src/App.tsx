import { useEffect } from "react";
import { Switch, Route, Router } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
import { apiRequest, queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import Dashboard from "@/pages/dashboard";
import Settings from "@/pages/settings";
import Changelogs from "@/pages/changelogs";
import Releases from "@/pages/releases";
import Logs from "@/pages/logs";
import Usage from "@/pages/usage";
import NotFound from "@/pages/not-found";
import { WebLoginGate } from "@/components/WebLoginGate";

let appOpenRecorded = false;

function AppRouter() {
  return (
    <Switch>
      <Route path="/" component={Dashboard} />
      <Route path="/settings" component={Settings} />
      <Route path="/changelogs" component={Changelogs} />
      <Route path="/releases" component={Releases} />
      <Route path="/logs" component={Logs} />
      <Route path="/usage" component={Usage} />
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  useEffect(() => {
    if (appOpenRecorded) {
      return;
    }

    appOpenRecorded = true;
    void apiRequest("POST", "/api/usage/app-open")
      .then(() => queryClient.invalidateQueries({ queryKey: ["/api/usage"] }))
      .catch(() => {
        appOpenRecorded = false;
      });
  }, []);

  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <Toaster />
          <WebLoginGate>
            <Router hook={useHashLocation}>
              <AppRouter />
            </Router>
          </WebLoginGate>
        </TooltipProvider>
      </QueryClientProvider>
    </ThemeProvider>
  );
}

export default App;
