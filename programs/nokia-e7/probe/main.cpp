#include <QApplication>
#include <QLabel>

int main(int argc, char *argv[])
{
    QApplication app(argc, argv);

    QLabel status;
    status.setAlignment(Qt::AlignCenter);
    status.setWordWrap(true);
    status.setStyleSheet(
        "QLabel {"
        "  background: #10141d;"
        "  color: #f7f7f2;"
        "  font-size: 22px;"
        "  padding: 24px;"
        "}"
    );
    status.setText(
        "<h2>PocketJS / Nokia E7</h2>"
        "<p>Qt 4.7.4 + GCCE + SIS toolchain is ready.</p>"
        "<p>RM-626 / Symbian Belle</p>"
    );
    status.showFullScreen();

    return app.exec();
}
