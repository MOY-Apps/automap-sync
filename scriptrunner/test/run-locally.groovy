/*
 * Runs AutomapSync.groovy outside Jira, the way ScriptRunner for Jira Cloud runs it:
 * Unirest imported for the script, settings taken from the environment instead of
 * Script Variables, and the "[n]" in a failure turned into the exit code n.
 *
 *   groovy run-locally.groovy ../AutomapSync.groovy
 */
@Grab('com.konghq:unirest-java:3.14.5')
import kong.unirest.Unirest
import org.codehaus.groovy.control.CompilerConfiguration
import org.codehaus.groovy.control.customizers.ImportCustomizer

def config = new CompilerConfiguration()
config.addCompilationCustomizers(new ImportCustomizer().addImports('kong.unirest.Unirest'))
def script = new File(args ? args[0] : 'AutomapSync.groovy')
try {
  def out = new GroovyShell(this.class.classLoader, new Binding(), config).evaluate(script)
  System.err.println("job result: ${out}")
  System.exit(0)
} catch (Throwable e) {
  def m = (e.message ?: '') =~ /^\[(\d)\]\s*(.*)$/
  if (m.find()) {
    System.err.println("automap-sync scriptrunner 1.0.0: ${m.group(2)}")
    System.exit(m.group(1).toInteger())
  }
  System.err.println("automap-sync scriptrunner 1.0.0: failed: ${e}")
  System.exit(6)
} finally {
  Unirest.shutDown()
}
